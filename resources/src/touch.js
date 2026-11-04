// Touch scrolling on the engine canvas. Browsers send a finger drag as touch/pointer input,
// which the loader doesn't forward, and by default they pan the host page instead; so a
// drag scrolled nothing in Firefox. With touch-action: none on the canvas (template.html)
// the page gets the whole gesture, and this turns it into scrolling inside Firefox:
//
//  - a one-finger drag scrolls what is under the point it started on, 1:1 with the finger
//    (like a phone, it stays with that element for the whole gesture);
//  - letting go while moving flings: the scroll glides on and slows down;
//  - a tap still reaches Firefox as a click and a long press as the context menu (the
//    browser's own compatibility mouse events, which the loader already forwards); once a
//    touch has scrolled, or stopped a fling, its click is cancelled.
//
// Scroll requests are merged while the engine is busy with the previous one, so a slow frame
// (single-thread mode, a large Resolution) doesn't queue up a backlog.

const SLOP = 8; // CSS px a finger moves before a touch is a scroll rather than a tap
const SAMPLE_MS = 100; // the fling's speed is the finger's over this last stretch
const MIN_FLING = 0.15; // px/ms: slower releases just stop
const FRICTION = 0.95; // speed kept per 1/60 s of fling
const STOP_FLING = 0.02; // px/ms

export function attachTouchScroll(canvas, gecko) {
  let touch = null; // the finger being followed
  let scrolled = false; // the last touch scrolled (its click is cancelled)
  let anchor = null; // page point the scroll is aimed at
  let pending = { dx: 0, dy: 0 };
  let busy = false;
  let fling = 0;

  const flush = () => {
    if (busy || !anchor || (!pending.dx && !pending.dy)) return;
    const { dx, dy } = pending;
    pending = { dx: 0, dy: 0 };
    busy = true;
    gecko.touchScroll(anchor.x, anchor.y, dx, dy).finally(() => {
      busy = false;
      flush();
    });
  };
  const scroll = (dx, dy) => {
    pending.dx += dx;
    pending.dy += dy;
    flush();
  };
  const stopFling = () => {
    if (fling) cancelAnimationFrame(fling);
    fling = 0;
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const caughtFling = !!fling;
    stopFling();
    if (touch) return; // more fingers: the first one leads
    scrolled = caughtFling; // a touch that stops a fling doesn't also click
    touch = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moving: false, samples: [] };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!touch || e.pointerId !== touch.id) return;
    if (!touch.moving) {
      if (Math.hypot(e.clientX - touch.x0, e.clientY - touch.y0) < SLOP) return;
      touch.moving = scrolled = true;
      pending = { dx: 0, dy: 0 };
      anchor = { x: touch.x0, y: touch.y0 };
    }
    // Content follows the finger: moving it up scrolls down.
    const dx = touch.x - e.clientX;
    const dy = touch.y - e.clientY;
    touch.x = e.clientX;
    touch.y = e.clientY;
    touch.samples.push({ t: e.timeStamp, dx, dy });
    while (touch.samples.length > 1 && e.timeStamp - touch.samples[0].t > SAMPLE_MS) touch.samples.shift();
    scroll(dx, dy);
  });

  const release = (e) => {
    if (!touch || e.pointerId !== touch.id) return;
    const t = touch;
    touch = null;
    // Only movement just before the finger lifted counts: one that stopped first doesn't fling.
    const recent = t.samples.filter((p) => e.timeStamp - p.t <= SAMPLE_MS);
    if (!t.moving || e.type === 'pointercancel' || recent.length < 2) return;
    const span = Math.max(1, e.timeStamp - recent[0].t);
    let vx = recent.reduce((s, p) => s + p.dx, 0) / span;
    let vy = recent.reduce((s, p) => s + p.dy, 0) / span;
    if (Math.hypot(vx, vy) < MIN_FLING) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(50, now - last);
      last = now;
      const keep = FRICTION ** (dt / (1000 / 60));
      vx *= keep;
      vy *= keep;
      if (Math.hypot(vx, vy) < STOP_FLING) {
        fling = 0;
        return;
      }
      scroll(vx * dt, vy * dt);
      fling = requestAnimationFrame(step);
    };
    fling = requestAnimationFrame(step);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // A touch that scrolled is not a tap: keep the browser from clicking at the end of it.
  // (After a long drag the browser has already ruled out a click and won't let this cancel.)
  canvas.addEventListener('touchend', (e) => { if (scrolled && e.cancelable) e.preventDefault(); }, { passive: false });
}
