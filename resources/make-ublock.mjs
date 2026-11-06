// Builds the uBlock Origin bundle that proxyfox.html preinstalls (resources/ublock/).
//
//   node resources/make-ublock.mjs --src <uBlock checkout> --assets-main <uAssets master>
//                                  --assets-prod <uAssets gh-pages>
//
// build.sh ublock clones the three at the commits pinned there and runs this. It does what
// uBlock Origin's own Firefox build does (tools/make-firefox.sh, copy-common-files.sh,
// make-assets.sh and make-firefox-meta.py at the pinned tag), in this script's own code:
// copy the extension's files and its default filter lists, then set the manifest's
// version. The result is the unpacked extension in a tar (sorted, fixed dates, so the same
// inputs give the same bytes), zstd-compressed: resources/ublock/ublock.tar.zst, and
// ublock.json describing it. pack.mjs embeds it; app.js installs it as a built-in add-on.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || !argv[i + 1]) throw new Error(`make-ublock: --${name} is required`);
  return path.resolve(argv[i + 1]);
};
const SRC = arg('src');
const MAIN = arg('assets-main');
const PROD = arg('assets-prod');
const OUT_DIR = path.join(HERE, 'ublock');
const git = (dir) => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const version = fs.readFileSync(path.join(SRC, 'dist', 'version'), 'utf8').trim();
const stable = /^\d+\.\d+\.\d+$/.test(version);

// Extension path -> source file.
const files = new Map();
function addFile(dest, src) {
  if (!fs.statSync(src).isFile()) throw new Error(`make-ublock: not a file: ${src}`);
  files.set(dest, src);
}
function addTree(dest, src) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = dest ? `${dest}/${e.name}` : e.name;
    if (e.isDirectory()) addTree(d, s);
    else if (e.isFile()) addFile(d, s);
  }
}
function addGlob(destDir, srcDir, ext) {
  for (const name of fs.readdirSync(srcDir).sort()) {
    const s = path.join(srcDir, name);
    if (name.endsWith(ext) && fs.statSync(s).isFile()) addFile(destDir ? `${destDir}/${name}` : name, s);
  }
}

// make-assets.sh
addTree('assets', path.join(SRC, 'assets'));
files.delete(stable ? 'assets/assets.dev.json' : 'assets/assets.json');
for (const d of ['pgl.yoyo.org', 'publicsuffix.org', 'urlhaus-filter']) addTree(`assets/thirdparties/${d}`, path.join(MAIN, 'thirdparties', d));
for (const f of ['easylist.txt', 'easyprivacy.txt']) addFile(`assets/thirdparties/easylist/${f}`, path.join(PROD, 'thirdparties', f));
for (const f of ['badlists.txt', 'badware.min.txt', 'filters.min.txt', 'privacy.min.txt', 'quick-fixes.min.txt', 'unbreak.min.txt']) {
  addFile(`assets/ublock/${f}`, path.join(PROD, 'filters', f));
}
// copy-common-files.sh
addTree('css', path.join(SRC, 'src', 'css'));
addTree('img', path.join(SRC, 'src', 'img'));
addGlob('js', path.join(SRC, 'src', 'js'), '.js');
for (const d of ['resources', 'codemirror', 'scriptlets', 'wasm']) addTree(`js/${d}`, path.join(SRC, 'src', 'js', d));
addTree('lib', path.join(SRC, 'src', 'lib'));
addTree('web_accessible_resources', path.join(SRC, 'src', 'web_accessible_resources'));
addTree('_locales', path.join(SRC, 'src', '_locales'));
addGlob('', path.join(SRC, 'src'), '.html');
addGlob('js', path.join(SRC, 'platform', 'common'), '.js');
addGlob('', path.join(SRC, 'platform', 'common'), '.json');
addFile('LICENSE.txt', path.join(SRC, 'LICENSE.txt'));
// make-firefox.sh
addGlob('', path.join(SRC, 'platform', 'firefox'), '.json');
addGlob('js', path.join(SRC, 'platform', 'firefox'), '.js');
for (const [d, s] of [...files]) if (d.startsWith('_locales/nb/')) files.set('_locales/no/' + d.slice('_locales/nb/'.length), s);
files.delete('img/icon_128.png');

// make-firefox-meta.py: the version, and no sidebar on a stable release.
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const manifest = JSON.parse(fs.readFileSync(files.get('manifest.json'), 'utf8'));
if ('sidebar_action' in manifest && !/^\d+\.\d+\.\d+\.\d+$/.test(version)) delete manifest.sidebar_action;
manifest.version = version;
const generated = new Map([['manifest.json', Buffer.from(JSON.stringify(sortKeys(manifest), null, 2) + '\n')]]);
const id = manifest.browser_specific_settings.gecko.id;

// The unpacked extension in a plain ustar archive: sorted names, mode 0644, owner 0, date 0,
// so the same inputs give the same bytes; zstd-compressed with Node's own zstd.
if (typeof zlib.zstdCompressSync !== 'function') throw new Error('make-ublock: needs Node.js 22.15 or newer (zstd in node:zlib)');
function tarHeader(name, size) {
  const h = Buffer.alloc(512);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (cut < 0 || Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`make-ublock: path too long for ustar: ${name}`);
  }
  h.write(base, 0);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(prefix, 345);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const names = [...new Set([...files.keys(), ...generated.keys()])].sort();
const parts = [];
let rawSize = 0;
for (const name of names) {
  const data = generated.get(name) ?? fs.readFileSync(files.get(name));
  parts.push(tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  rawSize += data.length;
}
parts.push(Buffer.alloc(1024));
const tar = Buffer.concat(parts);
const zst = zlib.zstdCompressSync(tar, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'ublock.tar.zst'), zst);
fs.rmSync(path.join(OUT_DIR, 'ublock.xpi'), { force: true });
const info = {
  id,
  version,
  files: names.length,
  tarSize: tar.length,
  tarSha256: crypto.createHash('sha256').update(tar).digest('hex'),
  sources: {
    'gorhill/uBlock': git(SRC),
    'uBlockOrigin/uAssets master': git(MAIN),
    'uBlockOrigin/uAssets gh-pages': git(PROD),
  },
};
fs.writeFileSync(path.join(OUT_DIR, 'ublock.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`make-ublock: uBlock Origin ${version} (${id}), ${names.length} files, ${(rawSize / 1048576).toFixed(1)} MB -> ublock.tar.zst ${(zst.length / 1048576).toFixed(1)} MB`);
