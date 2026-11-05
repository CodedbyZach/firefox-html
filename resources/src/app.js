// proxyfox.html launcher. Decodes the Base64 runtime assets embedded in this
// page, turns them into Blob URLs / in-memory providers, and boots the real
// Gecko engine through the project's own loader (gecko.js/js/index.ts, bundled
// with the pack-time patches in resources/*-loader.mjs). The boot sequence
// mirrors firefox-wasm/demo/chrome/src/main.ts.

import { Gecko } from 'gecko-lib';
import { ZSTDDecoder } from 'zstddec';
import { provideEngineAssets, provideWarmModule } from './embedded-assets.js';
import { patchGlue } from './glue-patches.js';
import { indexTar, makeTarProvider, REQUIRED_FILES } from './tar-fs.js';
import { createCoop } from './coop.js';
import { attachTouchScroll } from './touch.js';

const $ = (id) => document.getElementById(id);
const manifest = JSON.parse($('asset-manifest').textContent);
const BROWSER_CHROME_URL = 'chrome://browser/content/browser.xhtml';
const LS_KEY = 'firefox-html-opts-v2';

const canvas = $('screen');
const splash = $('splash');
const logBox = $('log');
const launchBtn = $('launch');
const optGpu = $('opt-gpu');
const optJit = $('opt-jit');
const optWisp = $('opt-wisp');
const optStart = $('opt-start');
const optQuiet = $('opt-quiet');
const optRes = $('opt-res');
const resApply = $('res-apply');
const resCancel = $('res-cancel');

// Firefox's own background calls seen in testing: Remote Settings
// (firefox.settings.services.mozilla.com) and region lookup
// (location.services.mozilla.com), plus the usual connectivity probes. With the
// option on, these Firefox prefs are added as an app default-prefs file in the
// in-memory front-end, so Gecko keeps them local. Pages you open are unaffected.
const QUIET_PREFS_PATH = 'browser/defaults/preferences/zz-firefox-html-quiet.js';
const PAGE_PREFS_PATH = 'browser/defaults/preferences/zz-firefox-html-page.js';
const QUIET_PREFS = `// Added by proxyfox.html: "Block Firefox's background calls to Mozilla".
pref("services.settings.server", "data:,#remote-settings-dummy/v1");
pref("browser.region.network.url", "");
pref("browser.region.update.enabled", false);
pref("network.captive-portal-service.enabled", false);
pref("network.connectivity-service.enabled", false);
`;
function addVirtualFile(index, filePath, text) {
  const parts = filePath.split('/');
  index.files.set(filePath, new TextEncoder().encode(text));
  let dir = '';
  for (let i = 0; i < parts.length; i++) {
    if (!index.dirs.has(dir)) index.dirs.set(dir, new Set());
    index.dirs.get(dir).add(parts[i]);
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
  }
}

// ---------------------------------------------------------------- logging --
const nativeConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
const MAX_LOG_LINES = 400;
// While Firefox is open the log card is out of sight, so lines wait here (the last
// MAX_LOG_LINES) and join the card when the launch page comes back: engine output then
// costs no page work. The browser console still gets every line as it happens.
let logHeld = null;
let logScrolling = false;
function logLine(level, args) {
  const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
  if (!logHeld) return void appendLogLine(level, text);
  logHeld.push([level, text]);
  if (logHeld.length > 2 * MAX_LOG_LINES) logHeld.splice(0, logHeld.length - MAX_LOG_LINES);
}
function appendLogLine(level, text) {
  const line = document.createElement('div');
  line.className = 'log-line ' + level;
  line.textContent = text;
  logBox.appendChild(line);
  while (logBox.childElementCount > MAX_LOG_LINES) logBox.firstElementChild.remove();
  // Scrolling to the end forces a layout: once per frame, not once per line.
  if (logScrolling) return;
  logScrolling = true;
  requestAnimationFrame(() => {
    logScrolling = false;
    logBox.scrollTop = logBox.scrollHeight;
  });
}
function holdLog(hold) {
  if (hold) {
    logHeld ??= [];
    return;
  }
  const lines = logHeld ?? [];
  logHeld = null;
  for (const [level, text] of lines.slice(-MAX_LOG_LINES)) appendLogLine(level, text);
}
function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => { logLine(level, args); nativeConsole[level](...args); };
}
addEventListener('error', (e) => console.error('[page] uncaught:', e.message));
addEventListener('unhandledrejection', (e) => console.error('[page] unhandled rejection:', e.reason));

// ------------------------------------------------------------- UI helpers --
function setCheck(name, state, detail) {
  const el = document.querySelector(`[data-check="${name}"]`);
  if (!el) return;
  el.dataset.state = state;
  el.querySelector('.check-detail').textContent = detail;
}
function setProgress(fraction, label, detail) {
  $('progress-fill').style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  $('progress-label').textContent = label;
  if (detail !== undefined) $('progress-detail').textContent = detail;
}
function setPhase(phase) { document.body.dataset.phase = phase; }
const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// --------------------------------------------------------- capability checks --
// Gecko runs on emscripten pthreads. With real Workers the shared wasm heap must be
// postMessage'd to them, which browsers only allow in a cross-origin-isolated page,
// so test the real thing; without it the threads run on this page (coop.js).
async function checkThreads() {
  let url;
  let w;
  try {
    const mem = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    url = URL.createObjectURL(new Blob(['onmessage=e=>{Atomics.store(new Int32Array(e.data.buffer),0,7);postMessage(1)}'], { type: 'text/javascript' }));
    w = new Worker(url);
    return await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, why: 'worker did not answer' }), 5000);
      w.onmessage = () => { clearTimeout(t); resolve({ ok: new Int32Array(mem.buffer)[0] === 7 }); };
      w.onerror = (e) => { clearTimeout(t); resolve({ ok: false, why: 'worker error: ' + (e.message || 'unknown') }); };
      try { w.postMessage(mem); } catch (e) { clearTimeout(t); resolve({ ok: false, why: e.message }); }
    });
  } catch (e) {
    return { ok: false, why: e.message };
  } finally {
    if (w) w.terminate();
    if (url) URL.revokeObjectURL(url);
  }
}

async function checkOpfs() {
  try {
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

function checkWebGL2() {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2') && typeof OffscreenCanvas === 'function' && typeof c.transferControlToOffscreen === 'function';
  } catch {
    return false;
  }
}

function probeWisp(url) {
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return resolve({ ok: false, why: e.message }); }
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve({ ok: false, why: 'no answer within 3 s' }); }, 3000);
    ws.onopen = () => { clearTimeout(t); ws.close(); resolve({ ok: true }); };
    ws.onerror = () => { clearTimeout(t); resolve({ ok: false, why: 'connection failed' }); };
  });
}

function defaultWispUrl() {
  // A relay chosen at build time (WISP_URL) wins; otherwise the hosting site's own /wisp/.
  if (manifest.build.defaultWisp) return manifest.build.defaultWisp;
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    const u = new URL('wisp/', location.href);
    u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.href;
  }
  return '';
}

// ------------------------------------------------------------- resolution --
// Options > Resolution: how many pixels Firefox is drawn with, at the same size. Above
// Current the engine renders more device pixels per CSS pixel (Gecko's
// layout.css.devPixelsPerPx), so text, images and edges get sharper. The step that matches
// the screen's own pixels is the sharpest; higher ones are drawn bigger and shrunk smoothly
// (supersampling). The steps are the usual widths up to 4K, plus the screen's own width on
// a high-DPI display; the height follows the window's shape. Gecko keeps a whole number of
// app units (60 per CSS pixel) per device pixel, so a step's ratio is rounded to 60 / n and
// the page, the engine and mouse input agree exactly. Input goes to the engine in CSS pixels
// (resolution-loader.mjs), and presses while a popup is open go through RES_PRESS_HANDLER.
const RES_PREFS_PATH = 'browser/defaults/preferences/zz-firefox-html-resolution.js';
// Installed in the chrome window when the ratio is above 1. The engine's own "press outside
// an open popup closes it" test (embed-input.cpp) compares CSS pixels with popup bounds in
// device pixels, so it would close a menu on a press inside it. This does that test in CSS
// pixels instead: no popup open, the engine gets the press as usual ('none'); a press
// outside every open popup closes the ones that close on outside clicks, and is consumed
// like the engine does; otherwise it reaches the popup or page as a native widget press.
// Tooltips don't count, as in the engine.
const RES_PRESS_HANDLER = `(() => {
  const open = new Set();
  addEventListener('popupshown', (e) => { if (e.originalTarget.localName !== 'tooltip') open.add(e.originalTarget); }, true);
  addEventListener('popuphidden', (e) => open.delete(e.originalTarget), true);
  window.__fhtmlPress = (x, y, button) => {
    for (const p of [...open]) if (!p.isConnected || p.state !== 'open') open.delete(p);
    if (!open.size) return 'none';
    const sx = x + mozInnerScreenX, sy = y + mozInnerScreenY;
    const hit = (p) => { const r = p.getOuterScreenRect(); return sx >= r.left && sx < r.right && sy >= r.top && sy < r.bottom; };
    const autohide = [...open].filter((p) => p.getAttribute('noautohide') !== 'true');
    if (autohide.length && ![...open].some(hit)) {
      for (const p of autohide) p.hidePopup();
      return 'closed';
    }
    windowUtils.sendNativeMouseEvent(Math.round(sx * devicePixelRatio), Math.round(sy * devicePixelRatio),
      windowUtils.NATIVE_MOUSE_MESSAGE_BUTTON_DOWN, button, 0, null);
    return 'native';
  };
  return 'ok';
})()`;
const RES_STEPS = [
  { name: '720p', width: 1280 },
  { name: '900p', width: 1600 },
  { name: '1080p', width: 1920 },
  { name: '1440p', width: 2560 },
  { name: '1800p', width: 3200 },
  { name: '4K', width: 3840 },
];
let resStops = [{ name: 'Current', width: 0 }];
let resApplied = 0; // width of the applied step; 0 = Current (the page's own size)
let userGpu = false; // the GPU acceleration choice made in Options
let launched = false;

const pageW = () => Math.max(1, innerWidth);
const pageH = () => Math.max(1, innerHeight);
const screenW = () => Math.round(pageW() * (devicePixelRatio || 1));
const geckoScale = (s) => 60 / Math.max(1, Math.round(60 / s));
function resSize(width) {
  const scale = width ? geckoScale(width / pageW()) : 1;
  return { scale, width: Math.round(pageW() * scale), height: Math.round(pageH() * scale) };
}
// Index of the step for a width: that step, or the nearest one below it if the window
// has grown past it since (steps under 5% above the page's width are left out).
function resIndexFor(width) {
  let best = 0;
  resStops.forEach((s, i) => { if (s.width && s.width <= width) best = i; });
  return best;
}
// The step in use: the applied one, or Current where the GPU renderer is missing.
const resAppliedIndex = () => (env.webgl2 ? resIndexFor(resApplied) : 0);

// Above Current the extra pixels have to come from the GPU renderer (WebRender): this
// engine build's software renderer paints one pixel per CSS pixel at any ratio
// (embed-paint.cpp, RenderDocument). So a Resolution above Current turns GPU acceleration
// on and locks it; Current gives back the choice made in Options.
function syncResGpu() {
  const forced = resAppliedIndex() !== 0;
  optGpu.checked = env.webgl2 && (forced || userGpu);
  optGpu.disabled = !env.webgl2 || forced || launched;
  $('gpu-forced').hidden = !forced;
}

function renderRes() {
  const i = Number(optRes.value);
  const { name, width: stepWidth } = resStops[i] || resStops[0];
  const { width, height } = resSize(stepWidth);
  const sw = screenW();
  const pending = i !== resAppliedIndex();
  const out = $('res-value');
  const label = document.createElement('b');
  label.textContent = name;
  out.replaceChildren(label, ` ${width} × ${height}`);
  if (Math.abs(width - sw) <= sw * 0.02) out.append(', matches your screen (sharpest)');
  else if (width > sw) out.append(width / sw < 1.095 ? ', just above your screen' : `, ${(width / sw).toFixed(1)}× your screen's pixels`);
  if (pending) out.append(Object.assign(document.createElement('em'), { textContent: ' (not applied)' }));
  else if (!env.webgl2 && resStops.length > 1) out.append(' (higher steps need WebGL2, which this browser lacks)');
  resApply.disabled = resCancel.disabled = !pending || optRes.disabled;
}

function layoutRes(selectedWidth) {
  const steps = RES_STEPS.filter((s) => s.width >= pageW() * 1.05);
  // A high-DPI screen's own width, unless a standard step is within 2% of it.
  const sw = screenW();
  if (sw >= pageW() * 1.05 && !steps.some((s) => Math.abs(s.width - sw) <= sw * 0.02)) {
    steps.push({ name: 'Native', width: sw });
    steps.sort((a, b) => a.width - b.width);
  }
  resStops = [{ name: 'Current', width: 0 }, ...steps];
  optRes.max = String(resStops.length - 1);
  optRes.disabled = resStops.length < 2 || !env.webgl2;
  $('res-stops').replaceChildren(...resStops.map((s, i) =>
    Object.assign(document.createElement('option'), { value: String(i), label: s.name })));
  optRes.value = String(env.webgl2 ? resIndexFor(selectedWidth) : 0);
  renderRes();
}

function setupRes(saved) {
  resApplied = Number(saved.res) || 0;
  layoutRes(resApplied);
  syncResGpu();
  optRes.addEventListener('input', renderRes);
  resApply.addEventListener('click', () => {
    resApplied = resStops[Number(optRes.value)].width;
    const o = loadOpts();
    o.res = resApplied;
    saveOpts(o);
    renderRes();
    syncResGpu();
  });
  resCancel.addEventListener('click', () => {
    optRes.value = String(resAppliedIndex());
    renderRes();
  });
  // The steps depend on the window's size; keep the slider's choice while it changes.
  let t;
  addEventListener('resize', () => {
    if (launched) return;
    clearTimeout(t);
    t = setTimeout(() => layoutRes(resStops[Number(optRes.value)]?.width ?? 0), 150);
  });
}

// Fit the engine's pixels to the page: smooth when they are shrunk (more of them than the
// screen has), pixelated as before when enlarged; and keep GPU mode's surfaces, which the
// loader sizes to the engine's pixel count, filling the page (template.html: body.res-scaled).
function fitScreen(engineWidth) {
  canvas.classList.toggle('smooth', engineWidth > pageW() * devicePixelRatio + 0.5);
  document.body.classList.toggle('res-scaled', engineWidth !== pageW());
}

// ------------------------------------------------------------------- quit --
// Quitting Firefox (Ctrl+Q, the menu's Exit, closing the last tab, a restart) comes back to
// this launch page. A real quit can't finish inside a page: the engine closes the browser
// window and keeps running with nothing to show. So the chrome window answers quit requests
// itself (QUIT_HANDLER, installed after boot) and Firefox stays loaded: the page says it
// closed, shows the launch page again, and Launch then opens Firefox again at once, with a
// fresh tab. That is also why the page doesn't reload for this: in single-thread mode a
// reload doesn't free the old engine (its threads are suspended in the page), so every
// launch after one got slower. Should the browser window really close some other way, the
// engine can't show Firefox again, and the page reloads instead. The chrome code reaches the
// page through dump(), which arrives on the engine's stdout (print below).
const QUIT_MARK = '[proxyfox.html:quit]';
const QUIT_HANDLER = `(() => {
  const say = (how) => dump(${JSON.stringify(QUIT_MARK)} + ' ' + how + '\\n');
  // Ctrl+Q and the menu's Exit (cmd_quitApplication): no "Quit Firefox?" prompt either.
  window.goQuitApplication = () => { say('quit'); return false; };
  // Everything else that asks to quit or restart, including closing the last tab.
  Services.obs.addObserver((cancel) => {
    cancel.QueryInterface(Ci.nsISupportsPRBool).data = true;
    say('quit');
  }, 'quit-application-requested');
  addEventListener('unload', () => say('closed'));
  return 'ok';
})()`;
// Fixes inside Firefox's window for things this engine build can't do (installed after boot).
//  - about:support and about:processes call ChromeUtils.requestProcInfo(), which reaches
//    GetProcInfoSync, a native function this build doesn't have: it aborted the thread that
//    called it. Every privileged global gets an answer describing this one process instead.
//  - Only this one window is drawn, so a new window, a private window or the Library opened
//    where nobody could see them (and could take the focus). They open as tabs instead.
const BROWSER_FIXES = `(() => {
  const done = [];
  const note = (label) => { try { gNotificationBox.appendNotification('proxyfox-note', { label, priority: gNotificationBox.PRIORITY_INFO_MEDIUM }, []); } catch (e) {} };
  const procInfo = async () => ({ pid: 1, childID: 0, filename: 'proxyfox', type: 'browser', origin: '', windows: [], utilityActors: [], threads: [], children: [], cpuTime: 0, cpuCycleCount: 0, memory: 0 });
  const patch = (g) => { try { if (g && g.ChromeUtils && g.ChromeUtils.requestProcInfo !== procInfo) g.ChromeUtils.requestProcInfo = procInfo; } catch (e) {} };
  patch(window);
  try { patch(Cu.getGlobalForObject(ChromeUtils.importESModule('resource://gre/modules/Troubleshoot.sys.mjs'))); done.push('procinfo'); } catch (e) {}
  Services.obs.addObserver((doc) => { try { if (doc.nodePrincipal && doc.nodePrincipal.isSystemPrincipal) patch(doc.defaultView); } catch (e) {} }, 'document-element-inserted');
  const tab = (url) => { gBrowser.selectedTab = gBrowser.addTrustedTab(url); };
  window.OpenBrowserWindow = (options) => {
    tab(BROWSER_NEW_TAB_URL);
    if (options && options.private) note("Private windows aren't available here, so this opened as a normal tab.");
    return window;
  };
  const openLinkIn = window.openLinkIn;
  window.openLinkIn = function (url, where, params) { return openLinkIn.call(this, url, where === 'window' ? 'tab' : where, params); };
  try {
    PlacesCommandHook.showPlacesOrganizer = (item) => tab(item === 'Downloads' ? 'about:downloads' : 'chrome://browser/content/places/places.xhtml');
    done.push('library');
  } catch (e) {}
  try { BrowserCommands.pageInfo = () => note("Page Info isn't available in this build."); } catch (e) {}
  return 'ok ' + done.join(',');
})()`;
// The fresh start the next Launch shows: popups closed, one new tab (or "Open after launch").
const freshStart = (start) => `(() => {
  for (const p of document.querySelectorAll('panel, menupopup')) if (p.state === 'open' || p.state === 'showing') p.hidePopup();
  const tab = gBrowser.addTrustedTab(${JSON.stringify(start || '')} || BROWSER_NEW_TAB_URL);
  gBrowser.selectedTab = tab;
  for (const t of [...gBrowser.tabs]) if (t !== tab) gBrowser.removeTab(t, { animate: false, skipPermitUnload: true });
  return String(gBrowser.tabs.length);
})()`;
const QUIT_SECONDS = 3;

let firefox = null; // the running engine, once booted: { gecko, start }
let quitTimer = 0;
let quitHow = '';

function showFirefox() {
  canvas.classList.add('ready');
  splash.classList.add('done');
  setPhase('running');
  scrollTo(0, 0); // the page may have been scrolled down to the Launch button
  canvas.focus();
  firefox?.gecko.refreshBox(); // laid out now: the box input positions map through (speed-loader.mjs)
  holdLog(true);
}
// After a quit: the launch page again, with Firefox loaded behind it and reset to a fresh tab.
async function backToLaunchPage() {
  clearInterval(quitTimer);
  quitTimer = 0;
  if (quitHow === 'closed' || !firefox) {
    $('quit-text').textContent = 'Going back to the launch page.';
    for (const b of [$('quit-stay'), $('quit-now')]) b.disabled = true;
    location.reload();
    return;
  }
  $('quit').hidden = true;
  holdLog(false);
  canvas.classList.remove('ready');
  splash.classList.remove('done');
  setPhase('ready');
  launchBtn.querySelector('span').textContent = 'Launch Firefox';
  launchBtn.disabled = false;
  $('relaunch-note').hidden = false;
  launchBtn.focus();
  const r = await firefox.gecko.evalChrome(freshStart(firefox.start)).catch((e) => String(e));
  console.log(`[proxyfox.html] back at the launch page; Firefox stays loaded (fresh start: ${r} tab)`);
}
function keepBrowsing() {
  clearInterval(quitTimer);
  quitTimer = 0;
  $('quit').hidden = true;
  canvas.focus();
}
// how: 'quit' (Firefox is still open, so it can be kept) or 'closed' (its window is gone).
function firefoxQuit(how) {
  if (how === 'closed') quitHow = 'closed'; // for good: this engine can't show Firefox again
  else if (quitHow !== 'closed') quitHow = 'quit';
  $('quit-stay').hidden = quitHow === 'closed';
  if (quitTimer) return; // already counting down
  if (quitHow === 'quit' && document.body.dataset.phase !== 'running') return; // not on screen
  let left = QUIT_SECONDS;
  const say = () => { $('quit-text').textContent = `Back to the launch page in ${left} s.`; };
  say();
  for (const b of [$('quit-stay'), $('quit-now')]) b.disabled = false;
  $('quit').hidden = false;
  $('quit-now').focus();
  quitTimer = setInterval(() => (--left > 0 ? say() : void backToLaunchPage()), 1000);
  console.log(`[proxyfox.html] Firefox ${how === 'closed' ? 'window closed' : 'quit'}: back to the launch page`);
}
function setupQuitDialog() {
  $('quit-now').addEventListener('click', () => void backToLaunchPage());
  $('quit-stay').addEventListener('click', keepBrowsing);
  $('quit').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('quit-stay').hidden) keepBrowsing();
  });
}
const engineOutput = (s) => {
  if (typeof s === 'string' && s.includes(QUIT_MARK)) firefoxQuit(s.includes(`${QUIT_MARK} closed`) ? 'closed' : 'quit');
};

// -------------------------------------------------------------------- app --
// On the website, proxyfox.html is also an installable app (PWA): manifest.webmanifest and
// sw.js next to it keep this 77 MB file on the device, so the app opens from disk, offline
// too, and an update downloads in the background. Opened from a file (shared on Discord,
// say) there is no service worker or manifest, and nothing here runs.
function setupApp() {
  if (!/^https?:$/.test(location.protocol) || !window.isSecureContext || !navigator.serviceWorker) return;
  const installed = () => matchMedia('(display-mode: standalone)').matches;
  navigator.serviceWorker.register('sw.js').then(() => {
    // The site has the app files, so the manifest is there too: offer to install.
    const manifestLink = document.createElement('link');
    manifestLink.rel = 'manifest';
    manifestLink.href = 'manifest.webmanifest';
    document.head.append(manifestLink);
    // As an app, ask the browser not to clear the copy on the device (and the profile)
    // when the disk runs low. Chromium answers without asking the user.
    if (installed()) void navigator.storage?.persist?.();
    console.log('[proxyfox.html] app: sw.js keeps this page on the device');
  }, (e) => console.log('[proxyfox.html] app: no sw.js on this site, so it opens from the network:', e.message));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'firefox-html-update') $('app-update').hidden = false;
  });
  $('app-update-reload').addEventListener('click', () => location.reload());
  // Chromium offers installing through this event; elsewhere the button just never shows.
  let install = null;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    install = e;
    $('install-app').hidden = false;
  });
  $('install-app').addEventListener('click', async () => {
    if (!install) return;
    $('install-app').hidden = true;
    install.prompt();
    await install.userChoice.catch(() => {});
    install = null;
  });
  addEventListener('appinstalled', () => {
    $('install-app').hidden = true;
    void navigator.storage?.persist?.();
  });
}

// ------------------------------------------------------------ asset decode --
function takeBase64(name) {
  const el = document.querySelector(`script[data-asset="${CSS.escape(name)}"]`);
  if (!el) throw new Error(`proxyfox.html is missing the embedded asset "${name}"`);
  const text = el.textContent;
  el.remove();
  return text;
}

async function base64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((b64.length / 4) * 3 - pad);
  const CHUNK = 1 << 22;
  let o = 0;
  for (let i = 0; i < b64.length; i += CHUNK) {
    const bin = atob(b64.slice(i, i + CHUNK));
    for (let j = 0; j < bin.length; j++) out[o++] = bin.charCodeAt(j);
    await tick(); // between 4 MB chunks: the checks, progress and input keep running
  }
  return out;
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function verify(name, bytes, expected, what) {
  const got = await sha256Hex(bytes);
  if (got === null) return 'unverified (no WebCrypto)';
  if (got !== expected) throw new Error(`${name}: ${what} SHA-256 mismatch (expected ${expected}, got ${got}); proxyfox.html is corrupt`);
  return 'sha256 ok';
}

const decoded = {};
async function decodeAssets() {
  const A = manifest.assets;
  const order = ['gecko.js', 'gecko.data', 'chrome-assets.tar', 'gecko.wasm'];
  // gecko.data stays compressed here: index.ts zstd-decodes it in getPreloadedPackage.
  const inflateHere = (n) => A[n].compression === 'zstd' && n !== 'gecko.data';
  const total = order.reduce((s, n) => s + A[n].stored + (inflateHere(n) ? A[n].size : 0), 0);
  let done = 0;
  const step = (n, label) => setProgress(done / total, label, `${n}`);
  const zstd = new ZSTDDecoder();
  await zstd.init();

  for (const name of order) {
    const meta = A[name];
    step(name, `Decoding ${name} (${fmtBytes(meta.stored)} Base64 payload)`);
    await tick();
    const bytes = await base64ToBytes(takeBase64(name));
    if (bytes.byteLength !== meta.stored) throw new Error(`${name}: decoded ${bytes.byteLength} bytes, expected ${meta.stored}`);
    const v1 = await verify(name, bytes, meta.sha256, 'stored payload');
    done += meta.stored;
    let raw = bytes;
    if (inflateHere(name)) {
      step(name, `Decompressing ${name} (${fmtBytes(meta.size)})`);
      await tick();
      raw = zstd.decode(bytes, meta.size);
      if (raw.byteLength !== meta.size) throw new Error(`${name}: decompressed ${raw.byteLength} bytes, expected ${meta.size}`);
      await verify(name, raw, meta.sha256Raw, 'decompressed');
      done += meta.size;
    }
    console.log(`[proxyfox.html] ${name}: ${fmtBytes(meta.stored)} stored${meta.compression === 'zstd' ? ` / ${fmtBytes(meta.size)} raw` : ''}, ${v1}`);

    if (name === 'gecko.js') {
      // Fixes to the glue's JavaScript (glue-patches.js): Gecko's clock in a background tab,
      // reconnecting the relay, video frames. The embedded bytes stay as built.
      const glue = patchGlue(new TextDecoder().decode(raw));
      if (glue.missing.length) console.warn('[proxyfox.html] glue patches not applied:', glue.missing.join('; '));
      decoded.glueSource = glue.src;
    } else if (name === 'gecko.data') {
      // Handed to index.ts as bytes (speed-loader.mjs), which zstd-decodes them in
      // getPreloadedPackage: no blob URL to fetch and no extra copy.
      decoded.dataZstBytes = bytes;
    } else if (name === 'chrome-assets.tar') {
      const index = indexTar(raw);
      for (const p of REQUIRED_FILES) if (!index.files.has(p)) throw new Error(`chrome-assets.tar is missing ${p}`);
      decoded.chromeIndex = index;
      decoded.chromeFs = makeTarProvider(index);
      decoded.chromeFiles = index.files.size;
    } else if (name === 'gecko.wasm') {
      // application/wasm so index.ts can WebAssembly.instantiateStreaming() it.
      decoded.wasmUrl = URL.createObjectURL(new Blob([raw], { type: 'application/wasm' }));
    }
    await tick();
  }
  provideEngineAssets({
    glueSource: decoded.glueSource,
    dataZstBytes: decoded.dataZstBytes,
    meta: { dataCompressed: true, dataSize: A['gecko.data'].size, wasmCompressed: false, wasmSize: A['gecko.wasm'].size },
  });
  setProgress(1, 'Engine assets ready', `${decoded.chromeFiles} front-end files, ${fmtBytes(A['gecko.wasm'].size)} engine module`);
}

// ------------------------------------------------------------------ main --
const env = { threads: null, coop: false, jspi: false, opfs: false, webgl2: false };

function loadOpts() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function saveOpts(o) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch {}
}

// Without JSPI the engine can't run, but it can still be compiled: this shows the
// embedded module is the real, valid Gecko build (the same bytes the full launch uses).
async function proveEngine() {
  const el = $('engine-proof');
  try {
    const t0 = performance.now();
    const mod = await WebAssembly.compileStreaming(fetch(decoded.wasmUrl));
    const exp = WebAssembly.Module.exports(mod).map((e) => e.name);
    const imp = WebAssembly.Module.imports(mod);
    const shared = imp.some((i) => i.kind === 'memory');
    const keys = ['xul_init', 'main', 'xul_cmd_ptr', 'wisp_deliver', 'provider_record_entry'].filter((k) => exp.includes(k));
    el.textContent = `Gecko engine compiled by this browser in ${((performance.now() - t0) / 1000).toFixed(1)} s: ` +
      `${(manifest.assets['gecko.wasm'].size / 1048576).toFixed(0)} MB WebAssembly, ${exp.length} exports (${keys.join(', ')}), ` +
      `${imp.length} imports${shared ? ', imported shared memory (needs threads)' : ''}. sha256 ${manifest.assets['gecko.wasm'].sha256Raw.slice(0, 16)}...`;
    console.log('[proxyfox.html] ' + el.textContent);
  } catch (e) {
    el.textContent = 'Compiling the engine module failed: ' + e.message;
    console.error('[proxyfox.html] engine compile failed', e);
  }
}

async function runChecks() {
  env.jspi = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
  setCheck('jspi', env.jspi ? 'ok' : 'fail', env.jspi ? 'WebAssembly.Suspending / promising available' : 'Missing. Needs Chrome or Edge 137+ (Firefox: about:config javascript.options.wasm_js_promise_integration)');

  env.threads = await checkThreads();
  const coi = self.crossOriginIsolated ? 'cross-origin isolated' : 'not cross-origin isolated';
  // Workers can't receive the shared heap here (a file on disk, or a server without
  // COOP/COEP). Gecko's threads then all run on this page's thread instead (coop.js).
  env.coop = !env.threads.ok && env.jspi;
  setCheck('threads', env.threads.ok || env.coop ? 'ok' : 'fail',
    env.threads.ok ? `Shared wasm memory reaches Workers (${coi})`
      : env.coop ? 'Single-thread mode: Workers cannot share memory with this page, so Gecko\'s threads take turns on the page thread (slower, same engine)'
        : `Blocked: ${env.threads.why}`);

  env.opfs = await checkOpfs();
  setCheck('storage', env.opfs && !env.coop ? 'ok' : 'warn',
    !env.opfs ? 'OPFS blocked here: profile is kept in memory for this session only'
      : env.coop ? 'Single-thread mode keeps the profile in memory for this session only (saving it needs Workers)'
        : 'OPFS available: cookies and site data persist between visits');

  env.webgl2 = checkWebGL2();
  setCheck('webgl', env.webgl2 ? 'ok' : 'warn', env.webgl2 ? 'WebGL2 + OffscreenCanvas available' : 'Not available: software rendering only');

  if (!env.jspi) {
    document.body.dataset.blocked = '1';
    $('blocked-jspi').hidden = false;
  }
}

// ws(s):// with the trailing slash wisp-js needs; http(s):// becomes ws(s)://.
function normalizeWispUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  u = u.replace(/^http(s?):\/\//i, 'ws$1://');
  return u.endsWith('/') ? u : u + '/';
}

async function refreshWisp() {
  const url = normalizeWispUrl(optWisp.value);
  if (!url) { setCheck('wisp', 'warn', 'No WISP server set: only local pages (about:, data:, chrome:) will load'); return; }
  setCheck('wisp', 'pending', `Probing ${url}`);
  const r = await probeWisp(url);
  setCheck('wisp', r.ok ? 'ok' : 'warn', r.ok ? `Reachable: http(s) sites load through ${url}` : `${url} is not reachable or not allowed (${r.why}). Sites will fail to load until a WISP server accepts this page.`);
}

async function main() {
  setupQuitDialog();
  setupApp();
  // Chrome's Memory Saver (Edge: sleeping tabs) unloads big background tabs; coming back
  // reloads the page, which looked like Firefox breaking. Say what happened and how to stop it.
  $('discarded-note').hidden = !document.wasDiscarded;
  const saved = loadOpts();
  // An empty saved value (e.g. from a build without a default relay) falls back to the default.
  optWisp.value = saved.wisp || defaultWispUrl();
  optStart.value = saved.start ?? '';
  optJit.checked = saved.jit ?? false;
  optQuiet.checked = saved.quiet ?? true;
  $('build-info').textContent = `Gecko ${manifest.build.geckoVersion} (HeyPuter/firefox @ ${manifest.build.geckoCommit.slice(0, 10)}), firefox-wasm @ ${manifest.build.firefoxWasmCommit.slice(0, 10)}, emscripten ${manifest.build.emscripten}, built ${manifest.build.date}`;

  setPhase('checking');
  // The embedded engine decodes while the checks run (each step yields to them).
  const decoding = (async () => {
    await tick();
    await decodeAssets();
  })();
  decoding.catch(() => {}); // reported below, once the checks are done
  await runChecks();
  // Off by default: in testing, GPU mode drew <canvas> content with red and blue swapped.
  userGpu = saved.gpu ?? false;
  optGpu.addEventListener('change', () => { if (!optGpu.disabled) userGpu = optGpu.checked; });
  // After the checks: a Resolution above Current needs WebGL2 (syncResGpu).
  setupRes(saved);
  if ((env.threads.ok || env.coop) && env.jspi) {
    void refreshWisp();
    let wispTimer;
    optWisp.addEventListener('input', () => { clearTimeout(wispTimer); wispTimer = setTimeout(refreshWisp, 500); });
  } else {
    setCheck('wisp', 'warn', 'Not checked: Gecko cannot start in this page context (see above)');
  }

  setPhase('decoding');
  try {
    await decoding;
  } catch (e) {
    console.error('[proxyfox.html] asset decode failed:', e);
    setProgress(0, 'Embedded assets could not be decoded', e.message);
    setPhase('error');
    return;
  }
  setPhase('ready');
  launchBtn.disabled = !((env.threads.ok || env.coop) && env.jspi);
  if (!env.jspi) {
    $('engine-proof').hidden = false;
    void proveEngine();
  } else if (!launchBtn.disabled) {
    precompileEngine();
  }
  // After a quit Firefox is still loaded (see "quit"): Launch shows it again at once.
  launchBtn.onclick = () => {
    if (!firefox) return void launch();
    $('relaunch-note').hidden = true;
    showFirefox();
  };
}

// Launch is faster with the engine module already compiled: compile it now, in the
// background, while the launch page is open (speed-loader.mjs instantiates it). The
// compiled module holds its own copy, so the blob URL's is released.
function precompileEngine() {
  const t0 = performance.now();
  provideWarmModule(WebAssembly.compileStreaming(fetch(decoded.wasmUrl)).then((mod) => {
    URL.revokeObjectURL(decoded.wasmUrl);
    console.log(`[proxyfox.html] engine compiled in the background in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return mod;
  }, (e) => {
    console.warn('[proxyfox.html] background engine compile failed, so Launch compiles it:', e);
    return null;
  }));
}

async function launch() {
  launched = true;
  launchBtn.disabled = true;
  launchBtn.querySelector('span').textContent = 'Starting Firefox';
  // Apply is what sets the resolution; an unapplied slider position is dropped.
  optRes.value = String(resAppliedIndex());
  const useGpu = optGpu.checked; // on whenever the Resolution is above Current (syncResGpu)
  for (const el of [optGpu, optJit, optWisp, optStart, optQuiet, optRes]) el.disabled = true;
  renderRes();
  setPhase('booting');
  const opts = { gpu: userGpu, jit: optJit.checked, wisp: normalizeWispUrl(optWisp.value), start: optStart.value.trim(), quiet: optQuiet.checked, res: resApplied };
  saveOpts(opts);
  if (opts.quiet) {
    addVirtualFile(decoded.chromeIndex, QUIET_PREFS_PATH, QUIET_PREFS);
    console.log(`[proxyfox.html] background Mozilla calls blocked via /gre/${QUIET_PREFS_PATH}`);
  }

  // Prefs for this page (a virtual default-prefs file, read by Gecko at startup):
  //  - window.open() popups open as tabs: only this one window is drawn.
  //  - Software mode: CSS transform/opacity animations run on the main thread. Gecko hands
  //    them to its compositor otherwise, which never draws in this mode, so they stood still.
  //  - ?pref.NAME=value sets any other startup pref (true/false, a number, or text).
  const urlPrefs = [...new URLSearchParams(location.search)].filter(([k]) => k.startsWith('pref.') && k.length > 5)
    .map(([k, v]) => `pref(${JSON.stringify(k.slice(5))}, ${/^(true|false|-?\d+)$/.test(v) ? v : JSON.stringify(v)});\n`).join('');
  addVirtualFile(decoded.chromeIndex, PAGE_PREFS_PATH, '// Added by proxyfox.html (see app.js).\n' +
    'pref("browser.link.open_newwindow.restriction", 0);\n' +
    (useGpu ? '' : 'pref("layers.offmainthreadcomposition.async-animations", false);\n') + urlPrefs);

  const engineEnv = { GECKO_CHROME: '1' };
  if (useGpu) Object.assign(engineEnv, { GECKO_GPU: '1', GECKO_GL_PASSTHROUGH: '1', GECKO_WR_DIRECT: '1', GECKO_APZ: '1' });
  if (!opts.jit) engineEnv.GECKO_NOWASMJIT = '1';
  // Without OPFS (file:// pages) the native OPFS backend cannot start; this
  // documented engine switch keeps the profile on the in-memory WasmFS instead. The same
  // in single-thread mode: OPFS writes need a real Worker (in testing every profile write
  // failed with all threads on the page), so the profile stays in memory there too.
  if (!env.opfs || env.coop) engineEnv.GECKO_SKIP_OPFS = '1';
  // Single-thread mode: the coarse clock word is refreshed by a page-thread timer, which
  // cannot run while an engine thread does, so Gecko would see time stand still.
  if (env.coop) engineEnv.GECKO_COARSE_CLOCK = '0';
  // ?env.NAME=value sets an engine switch; ?env.NAME= (empty) removes it (switches are presence-based).
  for (const [k, v] of new URLSearchParams(location.search)) {
    if (!k.startsWith('env.')) continue;
    if (v === '') delete engineEnv[k.slice(4)];
    else engineEnv[k.slice(4)] = v;
  }
  console.log('[proxyfox.html] engine env', engineEnv, 'wisp', opts.wisp || '(none)');

  if (env.coop) {
    const coop = createCoop({ glueSource: decoded.glueSource, log: (m) => console.error(m), debug: new URLSearchParams(location.search).has('coopdebug') });
    window.__coop = coop;
    console.log('[proxyfox.html] single-thread mode: engine threads run cooperatively on the page thread');
  }

  // Resolution (Options): device pixels per CSS pixel, kept when the window resizes. Gecko
  // reads the ratio as a default pref at startup and lays out at the page's own size.
  const res = resSize(resStops[resAppliedIndex()].width);
  const engineSize = () => [Math.round(pageW() * res.scale), Math.round(pageH() * res.scale)];
  const [engineW, engineH] = engineSize();
  if (res.scale !== 1) {
    addVirtualFile(decoded.chromeIndex, RES_PREFS_PATH,
      `// Added by proxyfox.html: Options > Resolution.\npref("layout.css.devPixelsPerPx", "${res.scale}");\n`);
  }
  fitScreen(engineW);
  console.log(`[proxyfox.html] resolution ${engineW}x${engineH}` +
    (res.scale !== 1 ? ` (${res.scale.toFixed(3)} device pixels per CSS pixel)` : ''));

  const t0 = performance.now();
  const gecko = new Gecko({
    canvas,
    width: engineW,
    height: engineH,
    wasm: { url: decoded.wasmUrl, compressed: false },
    env: engineEnv,
    fs: decoded.chromeFs,
    profile: 'profile',
    wispUrl: opts.wisp || undefined,
    print: (s) => { engineOutput(s); console.log('[gecko]', s); },
    printErr: (s) => { engineOutput(s); console.warn('[gecko]', s); },
  });
  window.gecko = gecko;
  gecko.cssScale = res.scale; // mouse input in CSS pixels (resolution-loader.mjs)
  try {
    await gecko.init();
    console.log(`[proxyfox.html] engine initialized in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    attachTouchScroll(canvas, gecko);
    await gecko.load(BROWSER_CHROME_URL);
    const q = await gecko.evalChrome(QUIT_HANDLER);
    if (q !== 'ok') console.warn('[proxyfox.html] quit handler not installed:', q);
    const f = await gecko.evalChrome(BROWSER_FIXES);
    if (!/^ok/.test(f)) console.warn('[proxyfox.html] browser fixes not installed:', f);
    if (res.scale !== 1) {
      const r = await gecko.evalChrome(RES_PRESS_HANDLER);
      if (r !== 'ok') console.warn('[proxyfox.html] resolution: popup press handler not installed:', r);
    }
    console.log(`[proxyfox.html] Firefox front-end booted in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    await gecko.evalChrome(`setToolbarVisibility(document.getElementById('PersonalToolbar'), 'never'); 'ok'`).catch(() => {});
    // Same one-time DuckDuckGo default as the official chrome-demo.
    const SEARCH_KEY = 'firefox-html-search-seeded';
    let seeded = false;
    try { seeded = !!localStorage.getItem(SEARCH_KEY); localStorage.setItem(SEARCH_KEY, '1'); } catch {}
    if (!seeded || !env.opfs) {
      void gecko.evalChrome(`(() => { (async () => {
        const { SearchService } = ChromeUtils.importESModule('moz-src:///toolkit/components/search/SearchService.sys.mjs');
        await SearchService.init();
        const engine = SearchService.getEngineByName('DuckDuckGo');
        if (engine) await SearchService.setDefault(engine, SearchService.CHANGE_REASON.USER);
      })().catch(e => console.error('search seed: ' + e)); return 'ok'; })()`);
    }
    if (opts.start) void gecko.evalChrome(`openTrustedLinkIn(${JSON.stringify(opts.start)}, 'current'); 'ok'`);

    firefox = { gecko, start: opts.start };
    showFirefox();
    window.geckoLoad = (u) => gecko.load(u);
    window.geckoEvalChrome = (js) => gecko.evalChrome(js);
    window.__firefoxHtml = { booted: true, bootSeconds: (performance.now() - t0) / 1000, gpu: useGpu, resolution: { width: engineW, height: engineH, scale: res.scale } };

    const resizeEngine = () => {
      const [w, h] = engineSize();
      fitScreen(w);
      return gecko.resize(w, h);
    };
    await resizeEngine();
    let rt;
    addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resizeEngine, 200); });
  } catch (e) {
    console.error('[proxyfox.html] startup failed', e);
    setPhase('error');
    window.__firefoxHtml = { booted: false, error: String(e && e.message || e) };
  }
}

void main();
