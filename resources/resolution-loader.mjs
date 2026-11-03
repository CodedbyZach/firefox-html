// Pack-time patches for the upstream loader (gecko.js/js/index.ts) for the Resolution option
// (resources/src/app.js). Above Current, the engine renders `cssScale` device pixels per CSS
// pixel (Gecko's layout.css.devPixelsPerPx), so Firefox keeps its size and gets sharper.
//
//  - Mouse positions go to the engine in CSS pixels, which is what it expects (embed-input.cpp
//    converts them to device pixels itself). Wheel deltas are scrolled as device pixels, so
//    they are scaled by the same ratio and a notch scrolls as far as at Current.
//  - The engine's own "press outside an open popup closes it" test compares those CSS pixels
//    with popup bounds in device pixels, so above 1 it would close a menu on a press inside it.
//    With cssScale above 1, a press first asks the page's handler in the chrome window
//    (__fhtmlPress, installed by app.js): with no popup open it answers 'none' and the engine
//    gets the press as usual; otherwise the handler closes the popups (press outside) or
//    delivers the press as a native widget event (press inside), and the engine's is skipped.
//
// At cssScale 1 nothing changes. Exact matches against the pinned index.ts; packing fails
// if one is missing.

const PATCHES = [
  {
    name: 'css scale field',
    from: '  private W: number;\n',
    to: '  private W: number;\n' +
      '  /** Engine (device) pixels per CSS pixel, set by the page for its Resolution option. */\n' +
      '  cssScale = 1;\n',
  },
  {
    name: 'mouse positions in CSS pixels',
    from: '      x: Math.round((e.clientX - r.left) * (this.W / r.width)),\n' +
      '      y: Math.round((e.clientY - r.top) * (this.H / r.height)),\n',
    to: '      x: Math.round(((e.clientX - r.left) * (this.W / r.width)) / this.cssScale),\n' +
      '      y: Math.round(((e.clientY - r.top) * (this.H / r.height)) / this.cssScale),\n',
  },
  {
    name: 'wheel deltas in device pixels',
    from: "on('wheel', (e) => { const p = this.xy(e); this.run({ op: OP_WHEEL, x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: this.mods(e) }); e.preventDefault(); });\n",
    to: "on('wheel', (e) => { const p = this.xy(e); this.run({ op: OP_WHEEL, x: p.x, y: p.y, deltaX: e.deltaX * this.cssScale, deltaY: e.deltaY * this.cssScale, modifiers: this.mods(e) }); e.preventDefault(); });\n",
  },
  {
    name: 'press through the popup handler',
    from: "on('mousedown', (e) => { c.focus(); const p = this.xy(e); this.run({ op: OP_MOUSE, evType: 1, x: p.x, y: p.y, button: e.button, buttons: e.buttons, clickCount: e.detail, modifiers: this.mods(e) }); });\n",
    to: "on('mousedown', (e) => { c.focus(); const p = this.xy(e); this.run({ op: OP_MOUSE, evType: 1, x: p.x, y: p.y, button: e.button, buttons: e.buttons, clickCount: e.detail, modifiers: this.mods(e), press: this.cssScale !== 1 } as Cmd); });\n",
  },
  {
    name: 'popup handler before the engine press',
    from: '  private async runCmd(item: Cmd): Promise<number | string | null> {\n',
    to: '  private async runCmd(item: Cmd): Promise<number | string | null> {\n' +
      '    if ((item as Cmd & { press?: boolean }).press) {\n' +
      "      const js = `(() => { try { return typeof __fhtmlPress == 'function' ? __fhtmlPress(${item.x}, ${item.y}, ${item.button || 0}) : 'none'; } catch (e) { return 'none'; } })()`;\n" +
      "      if ((await this.runCmd({ op: OP_EVAL, url: js })) !== 'none') return null;\n" +
      '    }\n',
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
