// Pack-time patch for the upstream loader (gecko.js/js/index.ts): what the repaint policy
// needs to tell an idle page from a busy one. In software rendering the loader asks the
// engine for a full repaint on every animation frame; with every engine thread on the page
// thread (single-thread mode, src/coop.js) an unchanged, idle page would cost most of a
// core. This adds a hash of each frame and the time of the last input; speed-loader.mjs
// (applied after this) backs the repaint interval off when neither changes, in every mode.
// Exact matches against the pinned index.ts; packing fails if one is missing.

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
];

export function patchLoaderForCoop(src) {
  for (const p of PATCHES) {
    const n = src.split(p.from).length - 1;
    if (n !== 1) throw new Error(`coop-loader: "${p.name}" site found ${n} times in index.ts (expected 1)`);
    src = src.replace(p.from, () => p.to);
  }
  return src;
}
