// Pack-time patch for the upstream loader (gecko.js/js/index.ts) for the Resolution option
// (resources/src/app.js). Above the page's own size, the engine's screen has more pixels
// than the canvas shows. The loader already maps mouse positions by W / canvas width; this
// scales wheel deltas the same way, so a scroll moves the page the same distance on screen
// at every resolution. At the page's own size the factor is exactly 1. Exact match against
// the pinned index.ts; packing fails if it is missing.

const PATCHES = [
  {
    name: 'wheel deltas in engine pixels',
    from: "on('wheel', (e) => { const p = this.xy(e); this.run({ op: OP_WHEEL, x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: this.mods(e) }); e.preventDefault(); });\n",
    to: "on('wheel', (e) => { const p = this.xy(e); const r = this.canvas.getBoundingClientRect(); this.run({ op: OP_WHEEL, x: p.x, y: p.y, deltaX: e.deltaX * (this.W / r.width), deltaY: e.deltaY * (this.H / r.height), modifiers: this.mods(e) }); e.preventDefault(); });\n",
  },
];

export function patchLoaderForResolution(src) {
  for (const p of PATCHES) {
    const n = src.split(p.from).length - 1;
    if (n !== 1) throw new Error(`resolution-loader: "${p.name}" site found ${n} times in index.ts (expected 1)`);
    src = src.replace(p.from, () => p.to);
  }
  return src;
}
