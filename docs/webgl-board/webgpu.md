# The board in WebGPU: stages 1–2

A trial of drawing the canvas board with WebGPU instead of WebGL2. Nothing ships: WebGL2 is
the board, and WebGPU draws only with `GUI_BOARD_WEBGPU=1` on an unpackaged build
(`src/main/dev-flags.ts` → `WindowState.devBoardWebgpu` → `Board` → `BoardSurface`).

## Stage 1: one interface, one texture policy

- `board/backend.ts`: what `surface.tsx` drives. `resize`, `setInks`, `draw(input, camera,
  now)` (how soon to draw again), `trim`, `dispose`, and for the tiles' markers `thumbWidth`,
  `sharpScale`, `thumbChanges`, `keep`. A backend tells the surface `changed`, `lost`,
  `restored` and `failed` through hooks it's given; the WebGL2 one listens for its own
  `webglcontextlost`/`restored`.
- `board/draw-plan.ts`: one draw without the GPU: the scene, which texture each quad draws
  with, the zoom's and the camera's rest timing, and afterwards what to load, replace and
  free. `textures.ts` (thumbnails: widths, budget, eviction, settle) and `sharp-textures.ts`
  (sharp tiles) are the policy; a backend gives them a `TextureUpload` (make a texture from a
  bitmap, with or without mip levels; free it). `tests/board-textures.test.ts` runs the policy
  with a fake GPU.

## Stage 2: WebGPU behind the switch

`board/gpu/renderer.ts`. The quad and grid shaders in WGSL, the same instance layout
(`QUAD_STRIDE`, three `vec4`s), one uniform buffer for the view, pixel size, grid and inks;
premultiplied blending as GL's `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`; an opaque canvas in the
preferred format. Textures are `rgba8unorm`, uploaded with `copyExternalImageToTexture` from
the decoded bitmaps, with mip levels drawn a render pass a level, and sampled a level sharper
(`textureSampleBias(…, -1)`) as GL does. One bind group a texture, one draw each, as GL.

It starts asynchronously (adapter, device, pipelines validated in an error scope). Without
`navigator.gpu`, an adapter, a device or a valid pipeline it logs and falls back to WebGL2 on
a new canvas element (a canvas keeps the first kind of context it was asked for). A lost
device is made again once; if that fails it falls back the same way. The canvas says which
backend draws: `data-board-backend="webgl2" | "webgpu"`.

## What was checked

- `e2e/canvas-backends.spec.ts`: the same board launched with each backend, compared pixel
  by pixel. In a hidden e2e window on an Apple M5 Max, WebGPU got an adapter and the two
  pictures were identical (largest difference 0).
- With the switch, `canvas-sharp.spec.ts` and two of `canvas-surface.spec.ts` pass; the other
  two drive WebGL itself (`WEBGL_lose_context`, a stubbed `getContext('webgl2')`).

## Not done, and risks

- Memory not measured. `trim()` resizes the canvas by a row as GL's does; whether that gives a
  WebGPU canvas's buffers back is unknown.
- Device loss is minimal: not tested (WebGPU has no `WEBGL_lose_context`; `device.destroy()`
  reports `destroyed`, which is ignored as our own).
- Mip levels are a 2×2 linear filter a level; odd sizes round down, close to but not exactly
  what GL's `generateMipmap` does. Only mid-pinch draws use them.
- No atlas and no batching: a draw a texture, as GL.
- Colour matched in the comparison (sRGB in, sRGB canvas); a P3 display not checked.
