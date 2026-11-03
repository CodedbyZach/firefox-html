// Pack-time patch for the upstream loader (gecko.js/js/index.ts) in single-thread mode
// (src/coop.js). In software rendering the loader asks the engine for a full repaint on
// every animation frame. With real threads that work runs on other cores; with every
// engine thread on the page thread an unchanged, idle page would cost most of a core.
// When neither the frame nor input has changed recently, the repaint interval backs
// off (up to 500 ms); any change or input returns to every frame. Exact matches against
// the pinned index.ts; packing fails if one is missing. Without __geckoCoop the loader
// is unchanged.

const PATCHES = [
  {
    name: 'state fields',
    from: '  private blitDst32: Uint32Array | null = null;\n',
    to: '  private blitDst32: Uint32Array | null = null;\n' +
      '  private coopFrameHash = 0;\n' +
      '  private coopLastInput = 0;\n',
  },
  {
    name: 'input timestamp',
    from: '  private run(item: Cmd): Promise<number | string | null> {\n',
    to: '  private run(item: Cmd): Promise<number | string | null> {\n' +
      '    if (item.op !== OP_PAINT) this.coopLastInput = performance.now();\n',
  },
  {
    name: 'frame hash',
    from: '      if ((p & 0x00FFFFFF) !== 0x00FFFFFF) nonWhite++;\n    }\n',
    to: '      if ((p & 0x00FFFFFF) !== 0x00FFFFFF) nonWhite++;\n' +
      '      hash = (Math.imul(hash, 31) + p) | 0;\n' +
      '    }\n' +
      '    this.coopFrameHash = hash;\n',
  },
  {
    name: 'frame hash init',
    from: '    let nonWhite = 0;\n',
    to: '    let nonWhite = 0;\n    let hash = 0;\n',
  },
  {
    name: 'adaptive software repaint',
    from: '      const tick = async () => {\n' +
      '        if (!this.mod) return;\n' +
      '        await this.run({ op: OP_PAINT });\n' +
      '        if (this.mod) requestAnimationFrame(tick);\n' +
      '      };\n',
    to: '      const coop = !!(globalThis as { __geckoCoop?: { active?: boolean } }).__geckoCoop?.active;\n' +
      '      let backoff = 0;\n' +
      '      const tick = async () => {\n' +
      '        if (!this.mod) return;\n' +
      '        const before = this.coopFrameHash;\n' +
      '        await this.run({ op: OP_PAINT });\n' +
      '        if (coop) {\n' +
      '          const busy = this.coopFrameHash !== before || performance.now() - this.coopLastInput < 1500;\n' +
      '          backoff = busy ? 0 : Math.min(backoff ? backoff * 2 : 32, 500);\n' +
      '          if (backoff) {\n' +
      '            setTimeout(() => { if (this.mod) requestAnimationFrame(tick); }, backoff);\n' +
      '            return;\n' +
      '          }\n' +
      '        }\n' +
      '        if (this.mod) requestAnimationFrame(tick);\n' +
      '      };\n',
  },
];

export function patchLoaderForCoop(src) {
  for (const p of PATCHES) {
    const n = src.split(p.from).length - 1;
    if (n !== 1) throw new Error(`coop-loader: "${p.name}" site found ${n} times in index.ts (expected 1)`);
    src = src.replace(p.from, () => p.to);
  }
  return src;
}
