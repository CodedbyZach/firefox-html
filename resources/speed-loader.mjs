// Pack-time patches for the upstream loader (gecko.js/js/index.ts) that make the page lighter
// and Launch faster. Applied after coop-loader.mjs (frame hash, last input time),
// resolution-loader.mjs and touch-loader.mjs.
//
//  - Repaint policy, every mode: when the picture hasn't changed for 250 ms and there was no
//    input for 1.5 s, the software renderer is asked for a frame less often (down to every
//    500 ms); any change or input returns to every frame. (Backing off after a single
//    unchanged frame halved 24 and 30 fps video, which leaves every other frame unchanged.)
//    Multi-threaded, an idle Firefox used about a fifth of the page thread for repaints at
//    60 frames a second. Nothing is pulled while the tab is hidden, and GPU mode waits on a
//    250 ms timer between its idle popup polls instead of waking every frame.
//  - Drawing (software mode): frames reach the screen through WebGL2 (createGlBlit). The
//    engine's BGRA rows are uploaded as they are, the GPU swaps blue and red while drawing,
//    and only the 16-row bands that changed since the last frame are uploaded; that replaces
//    a JavaScript pass that rewrote every pixel and a full putImageData per frame. This is
//    used when the browser draws WebGL on a GPU; without one (or with ?env.GECKO_BLIT_2D=1)
//    the 2D path stays, skipping unchanged frames. ?env.GECKO_BLIT_GL=1 forces WebGL2.
//  - Launch: the engine module can be compiled by the page while its launch page is open
//    (app.js, through embedded-assets.js); instantiating it then skips the compile.
//    gecko.data is handed over as bytes instead of a blob URL to fetch.
//  - Memory above 2 GB: the engine's result pointer is read unsigned (see the last patches).
//  - Input: the canvas box that positions are mapped through is measured once and again on
//    resize, not on every mouse move. Input goes ahead of repaints still waiting in the
//    queue. A command's completion is awaited with Atomics.waitAsync, which would wake at
//    once if the engine signalled the word; this engine build only sets it, so the word is
//    checked every 1 ms (it was 4 ms). A coalesced mouse move resolves the call it replaces.
//
// Exact matches against the pinned index.ts; packing fails if one is missing.

// The software-mode WebGL2 blitter, inserted before the Gecko class. createGlBlit() returns
// null when the browser has no WebGL2, or draws WebGL in software (SwiftShader, llvmpipe,
// WARP: no GPU, or a blocklisted one); that is checked on a scratch canvas first, so #screen
// can still get its 2D context then. With software compositing the browser copies every
// WebGL frame back on the page thread, which measured slower than the 2D path (39% of the
// page thread for 720p30 video against 18%); on a GPU the frames stay on the GPU. frame() hashes each 16-row band of the engine's BGRA frame,
// uploads the bands that changed (straight from the shared heap when the browser allows a
// shared view, else through one staging copy), draws them with blue and red swapped in the
// shader, and returns a hash of every pixel for the repaint policy.
const GL_BLIT = String.raw`// speed-loader.mjs: software-mode frames through WebGL2 (see the patch for details).
function createGlBlit(canvas: HTMLCanvasElement, force: boolean): any {
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) return null;
  const info = probe.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(probe.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : probe.RENDERER) || '');
  probe.getExtension('WEBGL_lose_context')?.loseContext();
  if (!force && /swiftshader|llvmpipe|softpipe|software|basic render|microsoft warp/i.test(renderer)) return null;
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
  if (!gl) return null;
  const BAND = 16;
  let texW = 0, texH = 0, lost = false, all = true, direct = true;
  let bands = new Int32Array(0);
  let staging: Uint8Array | null = null;
  const setup = () => {
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p; out vec2 uv; void main() { uv = vec2(p.x + 1.0, 1.0 - p.y) * 0.5; gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float; uniform sampler2D t; in vec2 uv; out vec4 o; void main() { o = vec4(texture(t, uv).bgr, 1.0); }'));
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('blit program: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    texW = texH = 0;
    all = true;
  };
  setup();
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => { lost = false; setup(); });
  const upload = (heap: ArrayBufferLike, off: number, y: number, w: number, h: number) => {
    const n = w * h * 4;
    if (direct) {
      try {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(heap, off, n));
        return;
      } catch (e) {
        direct = false; // this browser doesn't take a view of shared memory here
      }
    }
    if (!staging || staging.length < n) staging = new Uint8Array(n);
    const part = staging.subarray(0, n);
    part.set(new Uint8Array(heap, off, n));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, part);
  };
  return {
    invalidate() { all = true; },
    frame(heap: ArrayBufferLike, ptr: number, W: number, H: number): number {
      const nb = Math.ceil(H / BAND);
      if (bands.length !== nb) { bands = new Int32Array(nb); all = true; }
      const px = new Uint32Array(heap, ptr, W * H);
      let frameHash = 0, first = -1;
      let runs: number[] = [];
      for (let b = 0; b < nb; b++) {
        let h = 0;
        for (let i = b * BAND * W, end = Math.min((b + 1) * BAND, H) * W; i < end; i++) h = (Math.imul(h, 31) + px[i]) | 0;
        frameHash = (Math.imul(frameHash, 31) + h) | 0;
        const changed = all || h !== bands[b];
        bands[b] = h;
        if (changed && first < 0) first = b;
        if (!changed && first >= 0) { runs.push(first, b); first = -1; }
      }
      if (first >= 0) runs.push(first, nb);
      if (lost) { all = true; return frameHash; }
      if (!runs.length) return frameHash;
      if (texW !== W || texH !== H) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        texW = W;
        texH = H;
        runs = [0, nb];
      }
      all = false;
      for (let r = 0; r < runs.length; r += 2) {
        const y0 = runs[r] * BAND, y1 = Math.min(runs[r + 1] * BAND, H);
        upload(heap, ptr + y0 * W * 4, y0, W, y1 - y0);
      }
      gl.viewport(0, 0, W, H);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return frameHash;
    },
  };
}

`;

const patches = (embedded) => [
  {
    name: 'handoff import',
    from: "import assets from '../wasm/gecko-assets.json';\n",
    to: "import assets from '../wasm/gecko-assets.json';\n" +
      `import { takeDataZstBytes, takeWarmModule } from ${JSON.stringify(embedded)};\n`,
  },
  {
    name: 'state fields',
    from: '  private detach: Array<() => void> = [];\n',
    to: '  private detach: Array<() => void> = [];\n' +
      '  private destroyed = false;\n' +
      '  /** Hash of the frame on the 2D canvas, valid until a resize or a context loss. */\n' +
      '  private blitDrawnHash = 0;\n' +
      '  private blitValid = false;\n' +
      '  /** The canvas box input positions are mapped through (refreshBox). */\n' +
      '  private box: DOMRect | null = null;\n' +
      '  /** Software mode: the WebGL2 blitter (createGlBlit), or null for the 2D path. */\n' +
      '  private glBlit: any = null;\n',
  },
  {
    name: 'software frames through WebGL2, else 2D',
    from: "      const ctx = this.canvas.getContext('2d');\n" +
      "      if (!ctx) throw new Error('gecko.js: canvas already has a non-2d context');\n" +
      '      this.ctx = ctx;\n',
    to: '      this.glBlit = this.opts.env?.GECKO_BLIT_2D ? null : createGlBlit(this.canvas, !!this.opts.env?.GECKO_BLIT_GL);\n' +
      '      if (!this.glBlit) {\n' +
      "        const ctx = this.canvas.getContext('2d');\n" +
      "        if (!ctx) throw new Error('gecko.js: canvas already has a non-2d context');\n" +
      '        this.ctx = ctx;\n' +
      '        // A restored canvas comes back blank: upload the next frame even if it is unchanged.\n' +
      "        this.canvas.addEventListener('contextrestored', () => { this.blitValid = false; });\n" +
      '      }\n',
  },
  {
    name: 'gecko.data as bytes',
    from: '      const dataZst = new Uint8Array(await (await fetch(geckoDataZst)).arrayBuffer());\n',
    to: '      // The page hands over the compressed bytes it already has: no blob URL to fetch.\n' +
      '      const dataZst = takeDataZstBytes() ?? new Uint8Array(await (await fetch(geckoDataZst)).arrayBuffer());\n',
  },
  {
    name: 'precompiled engine module',
    from: '          let r: WebAssembly.WebAssemblyInstantiatedSource;\n' +
      '          if (wasmCompressed) {\n',
    to: '          let r: WebAssembly.WebAssemblyInstantiatedSource;\n' +
      '          // Compiled by the page while its launch page was open, if it did (app.js).\n' +
      '          const warm = await (takeWarmModule() ?? Promise.resolve(null)).catch(() => null);\n' +
      '          if (warm) {\n' +
      '            r = { module: warm, instance: await WebAssembly.instantiate(warm, imports) };\n' +
      '          } else if (wasmCompressed) {\n',
  },
  {
    name: 'resize invalidates the frame and the box',
    from: '      this.blitImg = null;\n' +
      '      this.blitDst32 = null;\n' +
      '    }\n' +
      '    await this.run({ op: OP_PAINT });\n',
    to: '      this.blitImg = null;\n' +
      '      this.blitDst32 = null;\n' +
      '      this.blitValid = false;\n' +
      '      this.glBlit?.invalidate();\n' +
      '    }\n' +
      '    this.refreshBox();\n' +
      '    await this.run({ op: OP_PAINT });\n',
  },
  {
    name: 'destroy stops the loops',
    from: '  destroy(): void {\n    this.running = false;\n',
    to: '  destroy(): void {\n    this.running = false;\n    this.destroyed = true;\n',
  },
  {
    name: 'input ahead of waiting repaints',
    from: '      // coalesce consecutive mouse-moves so fast motion can\'t back up the queue.\n' +
      '      const last = this.queue[this.queue.length - 1];\n' +
      '      if (item.op === OP_MOUSE && item.evType === 0 && last &&\n' +
      '          last.op === OP_MOUSE && last.evType === 0) {\n' +
      '        this.queue[this.queue.length - 1] = item;\n' +
      '      } else {\n' +
      '        this.queue.push(item);\n' +
      '      }\n',
    to: '      // Input (anything but a repaint) goes ahead of repaints still waiting, not of other\n' +
      '      // input, so a click or key isn\'t held up behind frames.\n' +
      '      let at = this.queue.length;\n' +
      '      if (item.op !== OP_PAINT) while (at > 0 && this.queue[at - 1].op === OP_PAINT) at--;\n' +
      '      // coalesce consecutive mouse-moves so fast motion can\'t back up the queue.\n' +
      '      const last = this.queue[at - 1];\n' +
      '      if (item.op === OP_MOUSE && item.evType === 0 && last &&\n' +
      '          last.op === OP_MOUSE && last.evType === 0) {\n' +
      '        last.resolve?.(null); // the replaced move\'s caller is not left waiting\n' +
      '        this.queue[at - 1] = item;\n' +
      '      } else {\n' +
      '        this.queue.splice(at, 0, item);\n' +
      '      }\n',
  },
  {
    name: 'wait for completion',
    from: '    const start = performance.now();\n' +
      '    let st = 1;\n' +
      '    while (performance.now() - start < 120000) {\n' +
      '      st = Atomics.load(i32(), (this.cmd + ST) >> 2);\n' +
      '      if (st === 3 || st === -1) break;\n' +
      '      await new Promise((r) => setTimeout(r, item.op === OP_LOAD ? 20 : 4));\n' +
      '    }\n',
    to: '    const start = performance.now();\n' +
      '    // Sleep on the status word (Atomics.waitAsync) instead of polling it. This engine only\n' +
      '    // sets the word, so the timeout paces it: 1 ms (it was 4 ms; 20 ms for page loads).\n' +
      '    const at = (this.cmd + ST) >> 2, waitMs = item.op === OP_LOAD ? 20 : 1;\n' +
      '    let st = Atomics.load(i32(), at);\n' +
      '    while (st !== 3 && st !== -1 && performance.now() - start < 120000) {\n' +
      '      let w: { async: boolean; value: unknown } | null = null;\n' +
      "      try { w = (Atomics as any).waitAsync(i32(), at, st, waitMs); } catch { /* no waitAsync, or the heap isn't shared */ }\n" +
      '      if (w?.async) await w.value;\n' +
      '      else if (!w) await new Promise((r) => setTimeout(r, waitMs));\n' +
      '      st = Atomics.load(i32(), at);\n' +
      '    }\n',
  },
  {
    name: 'blit through WebGL2',
    from: '    if (!this.ctx) return 0;\n    if (!resPtr || !len) return 0;\n',
    to: '    if (this.glBlit) {\n' +
      '      // Same guard as the 2D path below: this thread\'s view of the heap may lag a growth.\n' +
      '      if (!resPtr || !len || (resPtr & 3) || len < this.W * this.H * 4 || resPtr + len > u8.buffer.byteLength) return 0;\n' +
      '      this.coopFrameHash = this.glBlit.frame(u8.buffer, resPtr, this.W, this.H);\n' +
      '      return 1;\n' +
      '    }\n' +
      '    if (!this.ctx) return 0;\n    if (!resPtr || !len) return 0;\n',
  },
  {
    name: 'unchanged frame is not uploaded',
    from: '    this.ctx.putImageData(this.blitImg, 0, 0);\n    return nonWhite;\n',
    to: '    // The hash (coop-loader.mjs) covers every pixel: an identical frame is already on the canvas.\n' +
      '    if (hash !== this.blitDrawnHash || !this.blitValid) {\n' +
      '      this.ctx.putImageData(this.blitImg, 0, 0);\n' +
      '      this.blitDrawnHash = hash;\n' +
      '      this.blitValid = true;\n' +
      '    }\n' +
      '    return nonWhite;\n',
  },
  {
    name: 'software repaint policy',
    from: '      // Software mode: the engine paints the whole frame into a BGRA buffer; we must\n' +
      '      // pull + blit it every frame.\n' +
      '      const tick = async () => {\n' +
      '        if (!this.mod) return;\n' +
      '        await this.run({ op: OP_PAINT });\n' +
      '        if (this.mod) requestAnimationFrame(tick);\n' +
      '      };\n' +
      '      requestAnimationFrame(tick);\n' +
      '      return;\n',
    to: '      // Software mode: the engine paints the whole frame into a BGRA buffer, pulled + blitted\n' +
      '      // every frame while something changes. Unchanged for 250 ms and no input for 1.5 s:\n' +
      '      // ask less often, doubling up to every 500 ms.\n' +
      '      let backoff = 0, lastChange = 0;\n' +
      '      let queued = false;\n' +
      '      const next = (ms: number) => {\n' +
      '        if (queued || this.destroyed) return;\n' +
      '        queued = true;\n' +
      '        const go = () => { queued = false; requestAnimationFrame(tick); };\n' +
      '        if (ms) setTimeout(go, ms); else go();\n' +
      '      };\n' +
      '      const tick = async () => {\n' +
      '        if (!this.mod || this.destroyed || document.hidden) return;\n' +
      '        const before = this.coopFrameHash;\n' +
      '        await this.run({ op: OP_PAINT });\n' +
      '        if (!this.mod || this.destroyed) return;\n' +
      '        const now = performance.now();\n' +
      '        if (this.coopFrameHash !== before) lastChange = now;\n' +
      '        // A 24 or 30 fps video leaves every other frame unchanged: idle means no change for 250 ms.\n' +
      '        const busy = now - lastChange < 250 || now - this.coopLastInput < 1500;\n' +
      '        backoff = busy ? 0 : Math.min(backoff ? backoff * 2 : 32, 500);\n' +
      '        next(backoff);\n' +
      '      };\n' +
      '      const onVisible = () => { if (!document.hidden) { backoff = 0; next(0); } };\n' +
      "      document.addEventListener('visibilitychange', onVisible);\n" +
      "      this.detach.push(() => document.removeEventListener('visibilitychange', onVisible));\n" +
      '      next(0);\n' +
      '      return;\n',
  },
  {
    name: 'GPU popup polling on a timer',
    from: '    const tick = async (now: number) => {\n' +
      '      if (!this.mod) return;\n' +
      '      const interval = this.popupShown ? 0 : IDLE_POLL_MS;\n' +
      '      if (now - lastPull >= interval) {\n' +
      '        lastPull = now;\n' +
      '        await this.run({ op: OP_PAINT });\n' +
      '      }\n' +
      '      if (this.mod) requestAnimationFrame(tick);\n' +
      '    };\n' +
      '    requestAnimationFrame(tick);\n',
    to: '    let queued = false;\n' +
      '    const next = (ms: number) => {\n' +
      '      if (queued || this.destroyed) return;\n' +
      '      queued = true;\n' +
      '      const go = () => { queued = false; requestAnimationFrame(tick); };\n' +
      '      if (ms) setTimeout(go, ms); else go();\n' +
      '    };\n' +
      '    const tick = async (now: number) => {\n' +
      '      if (!this.mod || this.destroyed || document.hidden) return;\n' +
      '      const interval = this.popupShown ? 0 : IDLE_POLL_MS;\n' +
      '      if (now - lastPull >= interval) {\n' +
      '        lastPull = now;\n' +
      '        await this.run({ op: OP_PAINT });\n' +
      '      }\n' +
      '      if (!this.mod || this.destroyed) return;\n' +
      '      next(this.popupShown ? 0 : IDLE_POLL_MS);\n' +
      '    };\n' +
      '    const onVisible = () => { if (!document.hidden) { lastPull = 0; next(0); } };\n' +
      "    document.addEventListener('visibilitychange', onVisible);\n" +
      "    this.detach.push(() => document.removeEventListener('visibilitychange', onVisible));\n" +
      '    next(0);\n',
  },
  {
    name: 'refreshBox method',
    from: '  private xy(e: MouseEvent | WheelEvent): { x: number; y: number } {\n',
    to: '  /** Measure the canvas box page positions are mapped through (again after it moves). */\n' +
      '  refreshBox(): DOMRect | null {\n' +
      '    const r = this.canvas.getBoundingClientRect();\n' +
      '    if (!r.width || !r.height) return null; // not laid out (display: none): keep the last box\n' +
      '    this.box = r;\n' +
      '    return r;\n' +
      '  }\n\n' +
      '  private xy(e: MouseEvent | WheelEvent): { x: number; y: number } {\n',
  },
  {
    name: 'positions through the measured box',
    from: '    const r = this.canvas.getBoundingClientRect();\n    return {\n',
    to: '    const r = this.box ?? this.refreshBox() ?? this.canvas.getBoundingClientRect();\n    return {\n',
  },
  {
    name: 'box refreshed on resize',
    from: "    on('mousemove', ",
    to: '    const onResize = () => { this.refreshBox(); };\n' +
      "    addEventListener('resize', onResize);\n" +
      "    this.detach.push(() => removeEventListener('resize', onResize));\n" +
      "    on('mousemove', ",
  },
  {
    name: 'createGlBlit helper',
    from: 'export class Gecko {\n',
    to: GL_BLIT + 'export class Gecko {\n',
  },
  // The engine's heap can grow past 2 GB (to 4 GB). Its result pointer was read as a signed
  // 32-bit number, so above 2 GB it was negative: a frame's view of the heap threw "Start
  // offset ... is outside the bounds of the buffer" (stopping the page's paint loop) and a
  // command's text result came from the wrong place. Read the pointer and length unsigned.
  {
    name: 'command results above 2 GB',
    from: '      const resPtr = i32()[(this.cmd + RES) >> 2], len = i32()[(this.cmd + LEN) >> 2];\n',
    to: '      const resPtr = i32()[(this.cmd + RES) >> 2] >>> 0, len = i32()[(this.cmd + LEN) >> 2] >>> 0;\n',
  },
  {
    name: 'frames above 2 GB',
    from: '    const resPtr = i32[(this.cmd + RES) >> 2], len = i32[(this.cmd + LEN) >> 2];\n',
    to: '    const resPtr = i32[(this.cmd + RES) >> 2] >>> 0, len = i32[(this.cmd + LEN) >> 2] >>> 0;\n',
  },
];

export function patchLoaderForSpeed(src, embeddedAssetsPath) {
  if (!src.includes('    this.coopFrameHash = hash;\n')) throw new Error('speed-loader: apply coop-loader.mjs first (frame hash)');
  for (const p of patches(embeddedAssetsPath)) {
    const n = src.split(p.from).length - 1;
    if (n !== 1) throw new Error(`speed-loader: "${p.name}" site found ${n} times in index.ts (expected 1)`);
    src = src.replace(p.from, () => p.to);
  }
  return src;
}
