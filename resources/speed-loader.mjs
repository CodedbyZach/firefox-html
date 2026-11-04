// Pack-time patches for the upstream loader (gecko.js/js/index.ts) that make the page lighter
// and Launch faster. Applied after coop-loader.mjs (frame hash, last input time),
// resolution-loader.mjs and touch-loader.mjs.
//
//  - Repaint policy, every mode: when neither the frame nor input changed recently, the
//    software renderer is asked for a frame less often (down to every 500 ms); any change or
//    input returns to every frame. Multi-threaded, an idle Firefox used about a fifth of the
//    page thread for repaints at 60 frames a second. A frame identical to the one on the
//    canvas is not uploaded again, nothing is pulled while the tab is hidden, and GPU mode
//    waits on a 250 ms timer between its idle popup polls instead of waking every frame.
//  - Launch: the engine module can be compiled by the page while its launch page is open
//    (app.js, through embedded-assets.js); instantiating it then skips the compile.
//    gecko.data is handed over as bytes instead of a blob URL to fetch.
//  - Input: the canvas box that positions are mapped through is measured once and again on
//    resize, not on every mouse move. A command's completion is awaited with
//    Atomics.waitAsync, which wakes at once when the engine signals the word; this engine
//    build only sets it, so the 4 ms timeout (the old poll interval) still paces it.
//    A coalesced mouse move resolves the call it replaces.
//
// Exact matches against the pinned index.ts; packing fails if one is missing.

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
      '  private box: DOMRect | null = null;\n',
  },
  {
    name: 'redraw after a 2D context loss',
    from: '      this.ctx = ctx;\n',
    to: '      this.ctx = ctx;\n' +
      '      // A restored canvas comes back blank: upload the next frame even if it is unchanged.\n' +
      "      this.canvas.addEventListener('contextrestored', () => { this.blitValid = false; });\n",
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
    name: 'coalesced mouse move resolves',
    from: '        this.queue[this.queue.length - 1] = item;\n',
    to: '        last.resolve?.(null); // the replaced move\'s caller is not left waiting\n' +
      '        this.queue[this.queue.length - 1] = item;\n',
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
      '    // Sleep on the status word (Atomics.waitAsync) instead of polling it; the timeout\n' +
      '    // is the old poll interval, so an engine that only sets the word is paced as before.\n' +
      '    const at = (this.cmd + ST) >> 2, waitMs = item.op === OP_LOAD ? 20 : 4;\n' +
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
      '      // every frame while something changes. Unchanged and no input for 1.5 s: ask less\n' +
      '      // often, doubling up to every 500 ms.\n' +
      '      let backoff = 0;\n' +
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
      '        const busy = this.coopFrameHash !== before || performance.now() - this.coopLastInput < 1500;\n' +
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
