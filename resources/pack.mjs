#!/usr/bin/env node
// Packs a finished firefox-wasm build into ONE self-contained firefox.html.
//
//   node resources/pack.mjs --repo /path/to/firefox-wasm [--out firefox.html]
//   The default WISP relay for websites is wss://itcode.vip/api/ (shown under Options);
//   WISP_URL=wss://relay.example/ bakes in another one, WISP_URL= (empty) none.
//   (build.sh / build.ps1 run this as their "pack" stage)
//
// Inputs (all produced by the upstream build, nothing is downloaded):
//   gecko.js/wasm/gecko.js            emscripten glue (main thread + pthread worker script)
//   gecko.js/wasm/gecko.wasm          the Gecko engine module (zstd'd here, cached)
//   gecko.js/wasm/gecko.data.zst      minimal GRE preload package (+ gecko-assets.json)
//   demo/chrome/public/chrome-assets.tar.zst  Firefox front-end + full GRE resources (+ .json)
//   gecko.js/js/index.ts              the official loader, bundled unmodified
//
// Each binary asset becomes a Base64 <script type="application/octet-stream">
// block; app.js decodes them, verifies SHA-256, and wires them into the runtime.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patchGlueForCoop } from './coop-glue.mjs';
import { patchLoaderForCoop } from './coop-loader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WISP_URL = 'wss://itcode.vip/api/';
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const REPO = path.resolve(arg('repo', path.join(HERE, '..', 'work', 'firefox-wasm')));
const OUT = path.resolve(arg('out', path.join(HERE, '..', 'firefox.html')));
const CACHE = path.join(HERE, 'build-cache');
const WASM_DIR = path.join(REPO, 'gecko.js', 'wasm');
const CHROME_PUBLIC = path.join(REPO, 'demo', 'chrome', 'public');
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const must = (p) => {
  if (!fs.existsSync(p)) {
    console.error(`pack: missing ${p}\n  build the engine first (build.sh engine / build.ps1 -Stage engine)`);
    process.exit(1);
  }
  return p;
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const git = (dir) => {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
};

// --- 1. collect the runtime assets ------------------------------------------
const glueBuilt = fs.readFileSync(must(path.join(WASM_DIR, 'gecko.js')), 'utf8');
if (!glueBuilt.includes('createGecko')) throw new Error('gecko.js does not look like the MODULARIZE createGecko glue');
for (const marker of ['__wrHoistVaryings', 'new WebAssembly.Suspending(_gl_present_yield)', '[manual JSPI] promising entry']) {
  if (!glueBuilt.includes(marker)) throw new Error(`gecko.js is missing the post-link patch marker "${marker}" (patch-gecko-shaderfix.mjs did not run)`);
}
if (!glueBuilt.includes('_emscripten_coop_wait')) {
  throw new Error('gecko.js has no cooperative-thread imports: the engine was linked without the firefox.html patches (build.sh engine applies them)');
}
// Single-thread mode for pages that can't share memory with Workers (resources/src/coop.js).
const glue = Buffer.from(patchGlueForCoop(glueBuilt));
const dataZst = fs.readFileSync(must(path.join(WASM_DIR, 'gecko.data.zst')));
const engineMeta = JSON.parse(fs.readFileSync(must(path.join(WASM_DIR, 'gecko-assets.json')), 'utf8'));
const dataRawPath = path.join(WASM_DIR, 'gecko.data');
const dataRaw = fs.existsSync(dataRawPath) ? fs.readFileSync(dataRawPath) : null;

// The wasm: prefer the raw module (make web); zstd -19 --long=27 once, cached by hash.
// (128 MB window, the same as upstream's --ultra -22 release path, so zstddec decodes
// it the same way; -22 is ~10x slower for ~4% less.)
let wasmZst;
let wasmRawSha;
let wasmSize;
const wasmRawPath = path.join(WASM_DIR, 'gecko.wasm');
if (fs.existsSync(wasmRawPath)) {
  const raw = fs.readFileSync(wasmRawPath);
  wasmRawSha = sha256(raw);
  wasmSize = raw.length;
  // PACK_ZSTD_LEVEL (default 19) only trades file size for packing time.
  const level = String(Number(process.env.PACK_ZSTD_LEVEL) || 19);
  const cached = path.join(CACHE, `gecko.wasm.${wasmRawSha.slice(0, 16)}${level === '19' ? '' : '.l' + level}.zst`);
  if (!fs.existsSync(cached)) {
    console.log(`pack: zstd -${level} --long=27 gecko.wasm (${mb(raw.length)}), one-time, cached in build-cache/`);
    execFileSync('zstd', ['-q', '-f', `-${level}`, '--long=27', '-T0', wasmRawPath, '-o', cached + '.tmp'], { stdio: 'inherit' });
    fs.renameSync(cached + '.tmp', cached);
  }
  wasmZst = fs.readFileSync(cached);
} else {
  const zstPath = must(path.join(WASM_DIR, 'gecko.wasm.zst'));
  wasmZst = fs.readFileSync(zstPath);
  const raw = execFileSync('zstd', ['-dc', zstPath], { maxBuffer: 2 ** 31 - 1 });
  wasmRawSha = sha256(raw);
  wasmSize = raw.length;
}
if (wasmSize !== engineMeta.wasmSize) throw new Error(`gecko.wasm is ${wasmSize} bytes but gecko-assets.json says ${engineMeta.wasmSize}`);

const chromeZst = fs.readFileSync(must(path.join(CHROME_PUBLIC, 'chrome-assets.tar.zst')));
const chromeMeta = JSON.parse(fs.readFileSync(must(path.join(CHROME_PUBLIC, 'chrome-assets.json')), 'utf8'));
const chromeRaw = execFileSync('zstd', ['-dc', path.join(CHROME_PUBLIC, 'chrome-assets.tar.zst')], { maxBuffer: 2 ** 31 - 1 });
if (chromeRaw.length !== chromeMeta.uncompressedSize) throw new Error('chrome-assets.tar.zst size does not match chrome-assets.json');

const assets = [
  { name: 'gecko.js', bytes: glue, compression: 'none' },
  { name: 'gecko.data', bytes: dataZst, compression: 'zstd', size: engineMeta.dataSize, sha256Raw: dataRaw ? sha256(dataRaw) : undefined },
  { name: 'chrome-assets.tar', bytes: chromeZst, compression: 'zstd', size: chromeRaw.length, sha256Raw: sha256(chromeRaw) },
  { name: 'gecko.wasm', bytes: wasmZst, compression: 'zstd', size: wasmSize, sha256Raw: wasmRawSha },
];

const emVersionFile = path.join(REPO, 'emsdk', 'upstream', 'emscripten', 'emscripten-version.txt');
const manifest = {
  format: 1,
  assets: Object.fromEntries(assets.map((a) => [a.name, {
    encoding: 'base64',
    compression: a.compression,
    stored: a.bytes.length,
    sha256: sha256(a.bytes),
    ...(a.size ? { size: a.size } : {}),
    ...(a.sha256Raw ? { sha256Raw: a.sha256Raw } : {}),
  }])),
  build: {
    firefoxWasmCommit: git(REPO),
    geckoCommit: git(path.join(REPO, 'firefox')),
    geckoVersion: fs.existsSync(path.join(REPO, 'firefox/browser/config/version.txt'))
      ? fs.readFileSync(path.join(REPO, 'firefox/browser/config/version.txt'), 'utf8').trim() : 'unknown',
    emscripten: fs.existsSync(emVersionFile) ? fs.readFileSync(emVersionFile, 'utf8').trim().replace(/"/g, '') : 'unknown',
    date: new Date().toISOString().slice(0, 10),
    defaultWisp: process.env.WISP_URL ?? DEFAULT_WISP_URL,
  },
};

// --- 2. bundle the launcher + the official loader -----------------------------
const loaderEntry = must(path.join(REPO, 'gecko.js', 'js', 'index.ts'));
const repoModules = path.join(REPO, 'gecko.js', 'node_modules');
const EMBEDDED = path.join(HERE, 'src', 'embedded-assets.js');
const embeddedAssetsPlugin = {
  name: 'firefox-html-embedded-assets',
  setup(b) {
    const map = {
      '../wasm/gecko.js?source': 'geckoGlueSource',
      '../wasm/gecko.data.zst?inline': 'geckoDataZstUrl',
      '../wasm/gecko-assets.json': 'geckoAssetsMeta',
    };
    b.onResolve({ filter: /^\.\.\/wasm\/gecko(\.js\?source|\.data\.zst\?inline|-assets\.json)$/ }, (a) => ({ path: map[a.path], namespace: 'embedded' }));
    b.onLoad({ filter: /.*/, namespace: 'embedded' }, (a) => ({
      contents: `export { ${a.path} as default } from ${JSON.stringify(EMBEDDED)};`,
      loader: 'js',
      resolveDir: HERE,
    }));
  },
};
// Single-thread mode repaint policy for the upstream loader (coop-loader.mjs).
const coopLoaderPlugin = {
  name: 'firefox-html-coop-loader',
  setup(b) {
    b.onLoad({ filter: /[\\/]gecko\.js[\\/]js[\\/]index\.ts$/ }, (a) => ({
      contents: patchLoaderForCoop(fs.readFileSync(a.path, 'utf8')),
      loader: 'ts',
    }));
  },
};
const bundle = await build({
  entryPoints: [path.join(HERE, 'src', 'app.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  legalComments: 'inline',
  alias: { 'gecko-lib': loaderEntry },
  // index.ts's own imports (zstddec, wisp-js client) resolve from the repo's pnpm
  // node_modules when present, else from this folder's node_modules (same versions).
  nodePaths: [repoModules, path.join(HERE, 'node_modules')],
  plugins: [embeddedAssetsPlugin, coopLoaderPlugin],
  logLevel: 'warning',
});
let appJs = bundle.outputFiles[0].text;
if (!appJs.includes('READY cmd=')) throw new Error('bundled loader does not contain gecko.js/js/index.ts');
if (!appJs.includes('coopFrameHash')) throw new Error('bundled loader is missing the single-thread repaint patch');
appJs = appJs.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

// --- 3. assemble firefox.html ---------------------------------------------------
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mpl = fs.readFileSync(must(path.join(REPO, 'LICENSE')), 'utf8');
// Full texts of every license whose code is bundled into the page. The dependency
// texts come from the same node_modules copies esbuild bundled.
const depLicense = (pkg) => {
  for (const base of [repoModules, path.join(HERE, 'node_modules')]) {
    const p = path.join(base, pkg, 'LICENSE');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error(`license text for ${pkg} not found`);
};
const rule = (title) => `\n\n==================== ${title} ====================\n\n`;
const licenseText = [
  'Gecko, the Firefox front-end, and the firefox-wasm embedder/loader:',
  `  Mozilla Public License 2.0. Source: https://github.com/HeyPuter/firefox @ ${manifest.build.geckoCommit}`,
  `  and https://github.com/HeyPuter/firefox-wasm @ ${manifest.build.firefoxWasmCommit}`,
  '  Licenses of the third-party code inside Gecko: open about:license in the running browser.',
  'wisp-js client (bundled, @mercuryworkshop/wisp-js 0.4.1): AGPL-3.0, source https://github.com/MercuryWorkshop/wisp-js',
  'zstddec 0.2.0 (bundled): MIT, https://github.com/donmccurdy/zstddec',
  'Icons: Lucide, ISC License, https://lucide.dev',
  rule('Mozilla Public License 2.0 (Gecko, Firefox, firefox-wasm)'), mpl,
  rule('GNU AGPL 3.0 (@mercuryworkshop/wisp-js)'), depLicense('@mercuryworkshop/wisp-js'),
  rule('MIT (zstddec)'), depLicense('zstddec'),
  rule('ISC (Lucide icons)'), fs.readFileSync(path.join(HERE, 'src', 'licenses', 'lucide-ISC.txt'), 'utf8'),
].join('\n');
const header = `<!-- Gecko ${manifest.build.geckoVersion} compiled to WebAssembly in one file. Unofficial build; Firefox is a trademark of the Mozilla Foundation. Source links and full license texts: Licenses section at the bottom of the page. -->`;

const template = fs.readFileSync(path.join(HERE, 'src', 'template.html'), 'utf8');
const [beforeAssets, afterAssets] = template.split('<!--ASSET_BLOCKS-->');
const fill = (s) => s
  .replace('<!--LICENSE_HEADER-->', header)
  .replace('<!--LICENSE_TEXT-->', () => escHtml(licenseText))
  .replace('<!--MANIFEST-->', () => JSON.stringify(manifest).replace(/</g, '\\u003c'))
  .replace('<!--APP_SCRIPT-->', () => appJs);

const tmp = OUT + '.tmp';
const fd = fs.openSync(tmp, 'w');
fs.writeSync(fd, fill(beforeAssets));
for (const a of assets) {
  fs.writeSync(fd, `<script type="application/octet-stream" data-asset="${a.name}" data-encoding="base64">`);
  const CH = 3 * 1024 * 1024; // multiple of 3 -> chunked base64 concatenates exactly
  for (let off = 0; off < a.bytes.length; off += CH) fs.writeSync(fd, a.bytes.subarray(off, off + CH).toString('base64'));
  fs.writeSync(fd, '</script>\n');
}
fs.writeSync(fd, fill(afterAssets));
fs.closeSync(fd);
fs.renameSync(tmp, OUT);

for (const a of assets) {
  console.log(`pack: ${a.name.padEnd(18)} stored ${mb(a.bytes.length).padStart(9)}${a.size ? ` (raw ${mb(a.size)})` : ''}  base64 ${mb(Math.ceil(a.bytes.length / 3) * 4)}`);
}
console.log(`pack: app+loader bundle ${mb(appJs.length)}`);
console.log(`pack: wrote ${OUT} (${mb(fs.statSync(OUT).size)})`);
