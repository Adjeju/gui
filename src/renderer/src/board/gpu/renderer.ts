import type { BoardCamera } from '../../../../shared/board'
import type { BoardBackend, BoardBackendHooks, BoardSources } from '../backend'
import { DrawPlan } from '../draw-plan'
import { INK, INK_COUNT, QUAD, QUAD_STRIDE, type SceneInput } from '../scene'
import type { TextureUpload } from '../textures'

/*
 * The board's pixels in WebGPU: a development trial (GUI_BOARD_WEBGPU=1, unpackaged builds)
 * of the same drawing as gl/renderer.ts, from the same scene and texture policy (draw-plan.ts).
 * The shaders are the GL ones in WGSL; one uniform buffer holds the view, the pixel size, the
 * grid and the inks. Each texture is a bind group of its own, drawn as GL draws it: quads
 * without a thumbnail together, each with one on its own. Mip levels are made with a render
 * pass a level, as WebGPU has no generateMipmap. A lost device is made again once; if it
 * can't be, the board goes back to WebGL2 (surface.tsx).
 */

// WebGPU's flags, which TypeScript's DOM types name but don't define.
const BUFFER = { COPY_DST: 0x8, VERTEX: 0x20, UNIFORM: 0x40 } as const
const TEXTURE = { COPY_DST: 0x2, TEXTURE_BINDING: 0x4, RENDER_ATTACHMENT: 0x10 } as const
const STAGE = { VERTEX: 0x1, FRAGMENT: 0x2 } as const

/** Floats in the uniform buffer: view (2), px, a spare, the grid (4), then the inks. */
const UNIFORM_FLOATS = 8 + INK_COUNT * 4
/** The format textures are kept in: the bitmap's bytes as they are, as GL's RGBA8. */
const FORMAT: GPUTextureFormat = 'rgba8unorm'

const SHADER = /* wgsl */ `
struct Uniforms {
  view: vec2f,
  px: f32,
  spare: f32,
  // The dot grid's spacing, and where its first cell starts, in board-view pixels.
  grid: vec4f,
  inks: array<vec4f, ${INK_COUNT}>,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var thumb_sampler: sampler;
@group(1) @binding(0) var thumb: texture_2d<f32>;

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) half_size: vec2f,
  @location(2) @interpolate(flat) shape: vec4f,
  @location(3) @interpolate(flat) paint: vec4f,
}

@vertex
fn quad_vertex(
  @builtin(vertex_index) vertex: u32,
  @location(0) rect: vec4f,
  @location(1) shape: vec4f,
  @location(2) paint: vec4f,
) -> Varyings {
  let corner = vec2f(f32(vertex & 1u), f32(vertex >> 1u));
  // Room for a stroke outside the edge, a shadow's blur, and a pixel of antialiasing.
  let pad = shape.z * shape.y + 2.0 * paint.w + u.px;
  let local = corner * (rect.zw + 2.0 * pad) - pad;
  var out: Varyings;
  out.local = local;
  out.half_size = rect.zw * 0.5;
  out.shape = shape;
  out.paint = paint;
  let clip = (rect.xy + local) / u.view * 2.0 - 1.0;
  out.position = vec4f(clip.x, -clip.y, 0.0, 1.0);
  return out;
}

fn box(p: vec2f, half_size: vec2f, radius: f32) -> f32 {
  let q = abs(p) - half_size + radius;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

@fragment
fn quad_fragment(v: Varyings) -> @location(0) vec4f {
  let radius = min(v.shape.x, min(v.half_size.x, v.half_size.y));
  let d = box(v.local - v.half_size, v.half_size, radius);
  var fill = u.inks[u32(v.paint.x)];
  let kind = i32(v.shape.w);
  // Sampled before anything branches (derivatives need it), a level sharper than it would
  // pick, as the GL shader does: a frame's thumbnail runs across its width from the top.
  let image = max(v.paint.z, 1.0);
  let sampled = textureSampleBias(
    thumb,
    thumb_sampler,
    vec2f(v.local.x / (2.0 * v.half_size.x), v.local.y / image),
    -1.0,
  );
  if (kind == ${QUAD.shadow}) {
    let blur = max(v.paint.w, u.px);
    return fill * (1.0 - smoothstep(-blur, blur, d));
  }
  if (kind == ${QUAD.thumb} && v.local.y < v.paint.z) {
    fill = vec4f(sampled.rgb, 1.0);
  }
  let width = v.shape.y;
  let outer = d - v.shape.z * width;
  let within = clamp(0.5 - d / u.px, 0.0, 1.0);
  var band = 0.0;
  if (width > 0.0) {
    band = clamp(0.5 - outer / u.px, 0.0, 1.0) - clamp(0.5 - (outer + width) / u.px, 0.0, 1.0);
  }
  let stroke = u.inks[u32(v.paint.y)] * band;
  return stroke + fill * within * (1.0 - stroke.a);
}

@vertex
fn grid_vertex(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32(vertex & 1u), f32(vertex >> 1u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

// CSS's radial-gradient(ink 1px, transparent 1px), tiled: a dot a pixel in radius at the
// middle of every cell. The position's origin is the top left, as the board's is.
@fragment
fn grid_fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let at = position.xy * u.px - u.grid.yz;
  let size = u.grid.x;
  let cell = at - size * floor(at / size) - 0.5 * size;
  return u.inks[${INK.lineStrong}] * clamp(0.5 - (length(cell) - 1.0) / u.px, 0.0, 1.0);
}
`

/** Each mip level drawn from the one above it, filtered: what generateMipmap does in GL. */
const MIP_SHADER = /* wgsl */ `
@group(0) @binding(0) var above: texture_2d<f32>;
@group(0) @binding(1) var smooth_sampler: sampler;
struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@vertex
fn mip_vertex(@builtin(vertex_index) vertex: u32) -> Varyings {
  let corner = vec2f(f32(vertex & 1u), f32(vertex >> 1u));
  var out: Varyings;
  out.position = vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(corner.x, 1.0 - corner.y);
  return out;
}
@fragment
fn mip_fragment(v: Varyings) -> @location(0) vec4f {
  return textureSampleLevel(above, smooth_sampler, v.uv, 0.0);
}
`

interface GpuTexture {
  texture: GPUTexture
  group: GPUBindGroup
}

/** Everything made on one device; made again on a new one. */
interface DeviceParts {
  device: GPUDevice
  quad: GPURenderPipeline
  grid: GPURenderPipeline
  shared: GPUBindGroup
  textureLayout: GPUBindGroupLayout
  uniforms: GPUBuffer
  instances: GPUBuffer
  /** Quads the instance buffer has room for */
  room: number
  blank: GpuTexture
  mip: GPURenderPipeline
  mipSampler: GPUSampler
}

/** A device from the system's adapter, as large textures as it allows; throws when there's none. */
async function requestDevice() {
  if (!navigator.gpu) throw new Error('No WebGPU here')
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('No WebGPU adapter')
  return adapter.requestDevice({
    requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
  })
}

/** The pipelines, buffers and the blank texture for `device`; throws if one doesn't validate. */
async function makeParts(device: GPUDevice, format: GPUTextureFormat): Promise<DeviceParts> {
  device.pushErrorScope('validation')
  const module = device.createShaderModule({ code: SHADER })
  const sharedLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: STAGE.VERTEX | STAGE.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: STAGE.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  })
  const textureLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: STAGE.FRAGMENT, texture: { sampleType: 'float' } }],
  })
  // Inks are premultiplied: blendFunc(ONE, ONE_MINUS_SRC_ALPHA), as GL draws them.
  const blend: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  }
  const primitive: GPUPrimitiveState = { topology: 'triangle-strip' }
  const stride = QUAD_STRIDE * 4
  const quad = await device.createRenderPipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout, textureLayout] }),
    vertex: {
      module,
      entryPoint: 'quad_vertex',
      buffers: [
        {
          arrayStride: stride,
          stepMode: 'instance',
          attributes: [0, 1, 2].map((slot) => ({
            shaderLocation: slot,
            offset: slot * 16,
            format: 'float32x4' as const,
          })),
        },
      ],
    },
    fragment: { module, entryPoint: 'quad_fragment', targets: [{ format, blend }] },
    primitive,
  })
  const grid = await device.createRenderPipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout] }),
    vertex: { module, entryPoint: 'grid_vertex' },
    fragment: { module, entryPoint: 'grid_fragment', targets: [{ format, blend }] },
    primitive,
  })
  const mipModule = device.createShaderModule({ code: MIP_SHADER })
  const mip = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module: mipModule, entryPoint: 'mip_vertex' },
    fragment: { module: mipModule, entryPoint: 'mip_fragment', targets: [{ format: FORMAT }] },
    primitive,
  })
  const uniforms = device.createBuffer({
    size: UNIFORM_FLOATS * 4,
    usage: BUFFER.UNIFORM | BUFFER.COPY_DST,
  })
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  })
  const shared = device.createBindGroup({
    layout: sharedLayout,
    entries: [
      { binding: 0, resource: { buffer: uniforms } },
      { binding: 1, resource: sampler },
    ],
  })
  const room = 256
  const instances = device.createBuffer({
    size: room * stride,
    usage: BUFFER.VERTEX | BUFFER.COPY_DST,
  })
  // What a quad without a thumbnail samples.
  const blankTexture = device.createTexture({
    size: [1, 1],
    format: FORMAT,
    usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST,
  })
  device.queue.writeTexture(
    { texture: blankTexture },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4 },
    [1, 1],
  )
  const blank = {
    texture: blankTexture,
    group: device.createBindGroup({
      layout: textureLayout,
      entries: [{ binding: 0, resource: blankTexture.createView() }],
    }),
  }
  const mipSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const error = await device.popErrorScope()
  if (error) throw new Error(`The board's WebGPU pipelines did not validate: ${error.message}`)
  return {
    device,
    quad,
    grid,
    shared,
    textureLayout,
    uniforms,
    instances,
    room,
    blank,
    mip,
    mipSampler,
  }
}

/** Textures made on the current device: what the shared texture policy (draw-plan.ts) holds. */
class GpuTextures implements TextureUpload<GpuTexture> {
  constructor(private readonly parts: () => DeviceParts) {}

  upload(bitmap: ImageBitmap, mips: boolean): GpuTexture {
    const { device, textureLayout } = this.parts()
    const { width, height } = bitmap
    const levels = mips ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1
    const texture = device.createTexture({
      size: [width, height],
      format: FORMAT,
      mipLevelCount: levels,
      usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST | TEXTURE.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [width, height])
    if (levels > 1) this.mipmap(texture, levels)
    return {
      texture,
      group: device.createBindGroup({
        layout: textureLayout,
        entries: [{ binding: 0, resource: texture.createView() }],
      }),
    }
  }

  /** Each level below the first, drawn from the one above it. */
  private mipmap(texture: GPUTexture, levels: number) {
    const { device, mip, mipSampler } = this.parts()
    const encoder = device.createCommandEncoder()
    const layout = mip.getBindGroupLayout(0)
    for (let level = 1; level < levels; level++) {
      const view = (at: number) => texture.createView({ baseMipLevel: at, mipLevelCount: 1 })
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: view(level), loadOp: 'clear', storeOp: 'store' }],
      })
      pass.setPipeline(mip)
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: view(level - 1) },
            { binding: 1, resource: mipSampler },
          ],
        }),
      )
      pass.draw(4)
      pass.end()
    }
    device.queue.submit([encoder.finish()])
  }

  release({ texture }: GpuTexture) {
    texture.destroy()
  }
}

export class WebGpuRenderer implements BoardBackend {
  readonly kind = 'webgpu'
  private readonly plan: DrawPlan<GpuTexture>
  private readonly format = navigator.gpu.getPreferredCanvasFormat()
  private readonly uniformData = new Float32Array(UNIFORM_FLOATS)
  private inks: Float32Array = new Float32Array(INK_COUNT * 4)
  private view = { width: 0, height: 0 }
  private scale = 1
  private lost = false
  private disposed = false

  /** A renderer on `canvas`, once a device and its pipelines are made; throws when they can't be. */
  static async create(canvas: HTMLCanvasElement, sources: BoardSources, hooks: BoardBackendHooks) {
    const device = await requestDevice()
    try {
      const parts = await makeParts(device, navigator.gpu.getPreferredCanvasFormat())
      const context = canvas.getContext('webgpu') as GPUCanvasContext | null
      if (!context) throw new Error('The canvas gave no WebGPU context')
      return new WebGpuRenderer(canvas, context, parts, sources, hooks)
    } catch (error) {
      device.destroy()
      throw error
    }
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: GPUCanvasContext,
    private parts: DeviceParts,
    sources: BoardSources,
    private readonly hooks: BoardBackendHooks,
  ) {
    this.plan = new DrawPlan(new GpuTextures(() => this.parts), sources, hooks.changed)
    this.adopt(parts)
  }

  private adopt(parts: DeviceParts) {
    this.parts = parts
    // Opaque: the board's own colour is the first thing drawn, and nothing shows through.
    this.context.configure({ device: parts.device, format: this.format, alphaMode: 'opaque' })
    parts.device.addEventListener('uncapturederror', (event) =>
      console.error('[gui] board WebGPU:', (event as GPUUncapturedErrorEvent).error.message),
    )
    void parts.device.lost.then((info) => this.deviceLost(parts.device, info))
  }

  /** The device went: one new one is asked for; without it, this renderer has stopped. */
  private async deviceLost(device: GPUDevice, info: GPUDeviceLostInfo) {
    if (this.disposed || device !== this.parts.device) return
    console.warn(`[gui] the board's WebGPU device was lost (${info.reason}): ${info.message}`)
    this.lost = true
    this.plan.lost()
    this.hooks.lost()
    try {
      const next = await requestDevice()
      if (this.disposed) {
        next.destroy()
        return
      }
      this.adopt(await makeParts(next, this.format))
      this.lost = false
      this.hooks.restored()
    } catch (error) {
      console.warn('[gui] the board could not make a new WebGPU device:', error)
      if (!this.disposed) this.hooks.failed()
    }
  }

  resize(view: { width: number; height: number }, device: { width: number; height: number }) {
    this.view = view
    this.scale = view.width > 0 ? device.width / view.width : 1
    if (this.canvas.width !== device.width) this.canvas.width = device.width
    if (this.canvas.height !== device.height) this.canvas.height = device.height
    this.plan.resize(device)
  }

  setInks(inks: Float32Array) {
    this.inks = inks
  }

  keep(ids: ReadonlySet<string>) {
    this.plan.keep(ids)
  }

  thumbWidth(id: string) {
    return this.plan.thumbWidth(id)
  }

  sharpScale(id: string) {
    return this.plan.sharpScale(id)
  }

  get thumbChanges() {
    return this.plan.changes
  }

  draw(input: SceneInput, camera: BoardCamera, now: number): number | null {
    const { view, parts } = this
    if (this.lost || this.disposed || view.width <= 0 || view.height <= 0) return null
    if (this.canvas.width <= 0 || this.canvas.height <= 0) return null
    const { device } = parts
    const px = 1 / this.scale
    const { scene, textures } = this.plan.begin(input, camera, view, this.scale, now)
    const { quads } = scene

    const uniforms = this.uniformData
    uniforms[0] = view.width
    uniforms[1] = view.height
    uniforms[2] = px
    if (scene.grid) {
      uniforms[4] = scene.grid.size
      uniforms[5] = scene.grid.x
      uniforms[6] = scene.grid.y
    }
    uniforms.set(this.inks, 8)
    device.queue.writeBuffer(parts.uniforms, 0, uniforms)
    if (quads.count > parts.room) {
      parts.instances.destroy()
      parts.room = 2 ** Math.ceil(Math.log2(quads.count))
      parts.instances = device.createBuffer({
        size: parts.room * QUAD_STRIDE * 4,
        usage: BUFFER.VERTEX | BUFFER.COPY_DST,
      })
    }
    if (quads.count > 0)
      device.queue.writeBuffer(parts.instances, 0, quads.data, 0, quads.count * QUAD_STRIDE)

    const canvas = INK.canvas * 4
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: {
            r: this.inks[canvas],
            g: this.inks[canvas + 1],
            b: this.inks[canvas + 2],
            a: 1,
          },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.setBindGroup(0, parts.shared)
    if (scene.grid) {
      pass.setPipeline(parts.grid)
      pass.draw(4)
    }
    pass.setPipeline(parts.quad)
    pass.setVertexBuffer(0, parts.instances)
    const run = (first: number, count: number, texture: GpuTexture) => {
      if (count <= 0) return
      pass.setBindGroup(1, texture.group)
      pass.draw(4, count, 0, first)
    }
    // Quads without a thumbnail go together; each with one is a draw of its own, in order.
    let first = 0
    for (let index = 0; index < quads.count; index++) {
      const texture = textures[index]
      if (!texture) continue
      run(first, index - first, parts.blank)
      run(index, 1, texture)
      first = index + 1
    }
    run(first, quads.count - first, parts.blank)
    pass.end()
    device.queue.submit([encoder.finish()])

    return this.plan.end(camera, now)
  }

  /**
   * As GL's trim: the canvas a row taller and back, so the context's spare textures, each the
   * canvas's size, are made again at one. Not measured for WebGPU.
   */
  trim() {
    if (this.lost || this.disposed) return
    const { height } = this.canvas
    this.canvas.height = height + 1
    this.canvas.height = height
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.plan.dispose()
    const { parts } = this
    parts.instances.destroy()
    parts.uniforms.destroy()
    parts.blank.texture.destroy()
    this.context.unconfigure()
    parts.device.destroy()
    this.canvas.width = 0
    this.canvas.height = 0
  }
}
