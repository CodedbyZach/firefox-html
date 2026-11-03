// firefox.html launcher. Decodes the Base64 runtime assets embedded in this
// page, turns them into Blob URLs / in-memory providers, and boots the real
// Gecko engine through the project's own loader (gecko.js/js/index.ts, bundled
// unmodified). The boot sequence mirrors firefox-wasm/demo/chrome/src/main.ts.

import { Gecko } from 'gecko-lib';
import { ZSTDDecoder } from 'zstddec';
import { provideEngineAssets } from './embedded-assets.js';
import { indexTar, makeTarProvider, REQUIRED_FILES } from './tar-fs.js';
import { createCoop } from './coop.js';

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

// Firefox's own background calls seen in testing: Remote Settings
// (firefox.settings.services.mozilla.com) and region lookup
// (location.services.mozilla.com), plus the usual connectivity probes. With the
// option on, these Firefox prefs are added as an app default-prefs file in the
// in-memory front-end, so Gecko keeps them local. Pages you open are unaffected.
const QUIET_PREFS_PATH = 'browser/defaults/preferences/zz-firefox-html-quiet.js';
const QUIET_PREFS = `// Added by firefox.html: "Block Firefox's background calls to Mozilla".
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
function logLine(level, args) {
  const line = document.createElement('div');
  line.className = 'log-line ' + level;
  line.textContent = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
  logBox.appendChild(line);
  while (logBox.childElementCount > MAX_LOG_LINES) logBox.firstElementChild.remove();
  logBox.scrollTop = logBox.scrollHeight;
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

// ------------------------------------------------------------ asset decode --
function takeBase64(name) {
  const el = document.querySelector(`script[data-asset="${CSS.escape(name)}"]`);
  if (!el) throw new Error(`firefox.html is missing the embedded asset "${name}"`);
  const text = el.textContent;
  el.remove();
  return text;
}

function base64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((b64.length / 4) * 3 - pad);
  const CHUNK = 1 << 22;
  let o = 0;
  for (let i = 0; i < b64.length; i += CHUNK) {
    const bin = atob(b64.slice(i, i + CHUNK));
    for (let j = 0; j < bin.length; j++) out[o++] = bin.charCodeAt(j);
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
  if (got !== expected) throw new Error(`${name}: ${what} SHA-256 mismatch (expected ${expected}, got ${got}); firefox.html is corrupt`);
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
    const bytes = base64ToBytes(takeBase64(name));
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
    console.log(`[firefox.html] ${name}: ${fmtBytes(meta.stored)} stored${meta.compression === 'zstd' ? ` / ${fmtBytes(meta.size)} raw` : ''}, ${v1}`);

    if (name === 'gecko.js') {
      decoded.glueSource = new TextDecoder().decode(raw);
    } else if (name === 'gecko.data') {
      // index.ts fetch()es this URL and zstd-decodes it in getPreloadedPackage.
      decoded.dataZstUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
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
    dataZstUrl: decoded.dataZstUrl,
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
    console.log('[firefox.html] ' + el.textContent);
  } catch (e) {
    el.textContent = 'Compiling the engine module failed: ' + e.message;
    console.error('[firefox.html] engine compile failed', e);
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
  setCheck('storage', env.opfs ? 'ok' : 'warn', env.opfs ? 'OPFS available: cookies and site data persist between visits' : 'OPFS blocked here: profile is kept in memory for this session only');

  env.webgl2 = checkWebGL2();
  setCheck('webgl', env.webgl2 ? 'ok' : 'warn', env.webgl2 ? 'WebGL2 + OffscreenCanvas available' : 'Not available: software rendering only');

  if (!env.jspi) {
    document.body.dataset.blocked = '1';
    $('blocked-jspi').hidden = false;
  }
}

// Opt-in only: the public WISP proxy the upstream chrome-demo uses (its discovery URL comes
// from firefox-wasm/demo/chrome/src/main.ts). Never contacted unless the user clicks.
const PUBLIC_WISP_DISCOVERY = 'https://sensible-ship-8305.puter.work/';

// ws(s):// with the trailing slash wisp-js needs; http(s):// becomes ws(s)://.
function normalizeWispUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  u = u.replace(/^http(s?):\/\//i, 'ws$1://');
  return u.endsWith('/') ? u : u + '/';
}

// The upstream demo uses the discovery reply as-is as its WISP address. Accept the
// shapes that can take: a bare or quoted URL, or JSON with a URL in it.
function wispUrlFromAnswer(text) {
  let t = String(text).trim();
  try {
    const j = JSON.parse(t);
    if (typeof j === 'string') t = j;
    else if (j && typeof j === 'object') t = Object.values(j).filter((v) => typeof v === 'string').join(' ');
  } catch {}
  const m = /\b(?:wss?|https?):\/\/[^\s"'<>]+/i.exec(t);
  return m ? normalizeWispUrl(m[0]) : null;
}

async function usePublicWisp() {
  const ok = confirm("Use Puter's public WISP proxy?\n\nWebsites you open in this Firefox will connect through Puter's server. " +
    'HTTPS stays encrypted end to end (Gecko does the encryption); plain HTTP pages are visible to the proxy.');
  if (!ok) return;
  setCheck('wisp', 'pending', 'Fetching the public proxy address');
  try {
    const r = await fetch(PUBLIC_WISP_DISCOVERY, { cache: 'no-store' });
    const text = await r.text();
    const url = r.ok ? wispUrlFromAnswer(text) : null;
    if (!url) throw new Error(`no address in the answer (HTTP ${r.status}): "${text.trim().slice(0, 100)}"`);
    optWisp.value = url;
    await refreshWisp();
  } catch (e) {
    setCheck('wisp', 'warn', `Could not get the public proxy address: ${e.message}`);
  }
}

async function refreshWisp() {
  const url = normalizeWispUrl(optWisp.value);
  if (!url) { setCheck('wisp', 'warn', 'No WISP server set: only local pages (about:, data:, chrome:) will load'); return; }
  setCheck('wisp', 'pending', `Probing ${url}`);
  const r = await probeWisp(url);
  setCheck('wisp', r.ok ? 'ok' : 'warn', r.ok ? `Reachable: http(s) sites load through ${url}` : `${url} is not reachable or not allowed (${r.why}). Sites will fail to load until a WISP server accepts this page.`);
}

async function main() {
  const saved = loadOpts();
  optWisp.value = saved.wisp ?? defaultWispUrl();
  optStart.value = saved.start ?? '';
  optJit.checked = saved.jit ?? false;
  optQuiet.checked = saved.quiet ?? true;
  $('build-info').textContent = `Gecko ${manifest.build.geckoVersion} (HeyPuter/firefox @ ${manifest.build.geckoCommit.slice(0, 10)}), firefox-wasm @ ${manifest.build.firefoxWasmCommit.slice(0, 10)}, emscripten ${manifest.build.emscripten}, built ${manifest.build.date}`;

  setPhase('checking');
  await runChecks();
  // Off by default: in testing, GPU mode drew <canvas> content with red and blue swapped.
  optGpu.checked = env.webgl2 && (saved.gpu ?? false);
  optGpu.disabled = !env.webgl2;
  $('use-public-wisp').onclick = () => void usePublicWisp();
  if ((env.threads.ok || env.coop) && env.jspi) {
    void refreshWisp();
    let wispTimer;
    optWisp.addEventListener('input', () => { clearTimeout(wispTimer); wispTimer = setTimeout(refreshWisp, 500); });
  } else {
    setCheck('wisp', 'warn', 'Not checked: Gecko cannot start in this page context (see above)');
  }

  setPhase('decoding');
  try {
    await decodeAssets();
  } catch (e) {
    console.error('[firefox.html] asset decode failed:', e);
    setProgress(0, 'Embedded assets could not be decoded', e.message);
    setPhase('error');
    return;
  }
  setPhase('ready');
  launchBtn.disabled = !((env.threads.ok || env.coop) && env.jspi);
  if (!env.jspi) {
    $('engine-proof').hidden = false;
    void proveEngine();
  }
  launchBtn.onclick = () => void launch();
}

async function launch() {
  launchBtn.disabled = true;
  launchBtn.querySelector('span').textContent = 'Starting Firefox';
  for (const el of [optGpu, optJit, optWisp, optStart, optQuiet, $('use-public-wisp')]) el.disabled = true;
  setPhase('booting');
  const opts = { gpu: optGpu.checked, jit: optJit.checked, wisp: normalizeWispUrl(optWisp.value), start: optStart.value.trim(), quiet: optQuiet.checked };
  saveOpts(opts);
  if (opts.quiet) {
    addVirtualFile(decoded.chromeIndex, QUIET_PREFS_PATH, QUIET_PREFS);
    console.log(`[firefox.html] background Mozilla calls blocked via /gre/${QUIET_PREFS_PATH}`);
  }

  const engineEnv = { GECKO_CHROME: '1' };
  if (opts.gpu) Object.assign(engineEnv, { GECKO_GPU: '1', GECKO_GL_PASSTHROUGH: '1', GECKO_WR_DIRECT: '1', GECKO_APZ: '1' });
  if (!opts.jit) engineEnv.GECKO_NOWASMJIT = '1';
  // Without OPFS (file:// pages) the native OPFS backend cannot start; this
  // documented engine switch keeps the profile on the in-memory WasmFS instead.
  if (!env.opfs) engineEnv.GECKO_SKIP_OPFS = '1';
  // Single-thread mode: the coarse clock word is refreshed by a page-thread timer, which
  // cannot run while an engine thread does, so Gecko would see time stand still.
  if (env.coop) engineEnv.GECKO_COARSE_CLOCK = '0';
  // ?env.NAME=value sets an engine switch; ?env.NAME= (empty) removes it (switches are presence-based).
  for (const [k, v] of new URLSearchParams(location.search)) {
    if (!k.startsWith('env.')) continue;
    if (v === '') delete engineEnv[k.slice(4)];
    else engineEnv[k.slice(4)] = v;
  }
  console.log('[firefox.html] engine env', engineEnv, 'wisp', opts.wisp || '(none)');

  if (env.coop) {
    const coop = createCoop({ glueSource: decoded.glueSource, log: (m) => console.error(m), debug: new URLSearchParams(location.search).has('coopdebug') });
    window.__coop = coop;
    console.log('[firefox.html] single-thread mode: engine threads run cooperatively on the page thread');
  }

  const t0 = performance.now();
  const gecko = new Gecko({
    canvas,
    width: innerWidth,
    height: innerHeight,
    wasm: { url: decoded.wasmUrl, compressed: false },
    env: engineEnv,
    fs: decoded.chromeFs,
    profile: 'profile',
    wispUrl: opts.wisp || undefined,
    print: (s) => console.log('[gecko]', s),
    printErr: (s) => console.warn('[gecko]', s),
  });
  window.gecko = gecko;
  try {
    await gecko.init();
    console.log(`[firefox.html] engine initialized in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    await gecko.load(BROWSER_CHROME_URL);
    console.log(`[firefox.html] Firefox front-end booted in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
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

    canvas.classList.add('ready');
    splash.classList.add('done');
    setPhase('running');
    canvas.focus();
    window.geckoLoad = (u) => gecko.load(u);
    window.geckoEvalChrome = (js) => gecko.evalChrome(js);
    window.__firefoxHtml = { booted: true, bootSeconds: (performance.now() - t0) / 1000, gpu: opts.gpu };

    await gecko.resize(innerWidth, innerHeight);
    let rt;
    addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => gecko.resize(innerWidth, innerHeight), 200); });
  } catch (e) {
    console.error('[firefox.html] startup failed', e);
    setPhase('error');
    window.__firefoxHtml = { booted: false, error: String(e && e.message || e) };
  }
}

void main();
