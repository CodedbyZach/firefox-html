// Pack-time patch for the upstream loader (gecko.js/js/index.ts): a public touchScroll()
// for touch scrolling (resources/src/touch.js). The loader forwards mouse, wheel and keys
// but no touch input, so a finger drag reached Firefox as nothing at all. touchScroll()
// scrolls whatever is under a page point by CSS pixels through the engine's wheel path,
// which scrolls by exactly its delta in device pixels (cssScale per CSS pixel, from
// resolution-loader.mjs). The engine takes whole pixels, so sub-pixel remainders carry
// over to the next call and slow drags still add up exactly. Exact match against the
// pinned index.ts; packing fails if it is missing.

const PATCHES = [
  {
    name: 'touchScroll method',
    from: '  private xy(e: MouseEvent | WheelEvent): { x: number; y: number } {\n',
    to: '  private touchCarry = { x: 0, y: 0 };\n' +
      '  /** Scroll what is under page point (clientX, clientY) by (dx, dy) CSS pixels (touch scrolling). */\n' +
      '  touchScroll(clientX: number, clientY: number, dx: number, dy: number): Promise<number | string | null> {\n' +
      '    const p = this.xy({ clientX, clientY } as MouseEvent);\n' +
      '    const cx = this.touchCarry.x + dx * this.cssScale;\n' +
      '    const cy = this.touchCarry.y + dy * this.cssScale;\n' +
      '    const ix = Math.trunc(cx), iy = Math.trunc(cy);\n' +
      '    this.touchCarry = { x: cx - ix, y: cy - iy };\n' +
      '    if (!ix && !iy) return Promise.resolve(null);\n' +
      '    return this.run({ op: OP_WHEEL, x: p.x, y: p.y, deltaX: ix, deltaY: iy, modifiers: 0 });\n' +
      '  }\n\n' +
      '  private xy(e: MouseEvent | WheelEvent): { x: number; y: number } {\n',
  },
];

export function patchLoaderForTouch(src) {
  if (!src.includes('  cssScale = 1;\n')) throw new Error('touch-loader: apply resolution-loader.mjs first (cssScale)');
  for (const p of PATCHES) {
    const n = src.split(p.from).length - 1;
    if (n !== 1) throw new Error(`touch-loader: "${p.name}" site found ${n} times in index.ts (expected 1)`);
    src = src.replace(p.from, () => p.to);
  }
  return src;
}
