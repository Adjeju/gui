# WebGPU for the board: tried, not kept

The canvas board stays on WebGL2. In November 2026 a WebGPU renderer was built beside it and
measured against it; it drew the same board no better at the sizes users can have, so it was
removed. The branch `brijr/webgpu-renderer-benchmark` (commit `2652834`) holds the renderer
(`board/gpu/renderer.ts`), the development switch that turned it on, the pixel comparison, the
probe and its raw results.

## What was tried

A second renderer behind the interface in `board/backend.ts`, sharing the texture policy
(`draw-plan.ts`, `textures.ts`, `sharp-textures.ts`) and the scene with WebGL2: the same
quads and instance layout, the shaders in WGSL, textures uploaded with
`copyExternalImageToTexture` and their mip levels drawn a pass a level. It started
asynchronously and fell back to WebGL2 when it couldn't. That split stays: it is what lets
`tests/board-textures.test.ts` run the policy without a GPU.

## What was measured

Apple M5 Max, display at 2×, Electron 44 (Chromium 152), hidden windows, boards of 60, 500
and 2,000 desktop frames.

- **Pixels:** the same. Nine views (fitted, dark, selected, a marquee, sharp tiles at 200%,
  small thumbnails at 5%, mip levels mid-pinch, display scale 1, a section) differed by at
  most 2 of 255 on antialiased edges, with no pixel more than 8 apart.
- **At 60 frames** (`MAX_FRAMES`, all users can have): the same memory (page and GPU process
  within 7 MB), 60 frames a second both ways, a draw's script time under 0.2 ms both ways.
- **What WebGPU cost:** 23–36% more GPU-process CPU while the board pans or zooms, at every
  size; its first frame 8–13 ms later, since it starts asynchronously.
- **What it won, only at 500 and 2,000 frames:** 20–48 MB less GPU memory (WebGL2's per-texture
  overhead), about half the GPU time a draw with 360 frames in view, and no upload stalls
  (WebGL2 stalled 85–90 ms once a run on a mipmapped upload).
- **A crashed GPU process:** WebGPU drew everything again in 0.2–0.3 s, WebGL2 in 1.15 s.

## Why we stopped

At the board users can have, nothing a person sees or pays for is better with WebGPU, and it
costs more GPU-process CPU, a later first frame, and a second renderer (543 lines) and a
fallback path to keep matching the first. Its gains appear only with hundreds of frames in
view, which no user can open, and faster crash recovery happens once a crash.

## When to look again

If the frame limit rises to the hundreds. Even then, try in WebGL2 first: an atlas for the
small thumbnails would remove its per-texture overhead and be the batching that halves GPU
time a draw, and uploading wide thumbnails without mips (or spreading them out) would remove
its stalls. Not measured in the trial: 120 Hz displays, energy, P3 colour, other GPUs.
