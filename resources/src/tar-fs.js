// In-memory FsProvider over the decompressed chrome-assets tar (the non-binary
// GRE resources + the Firefox front-end `browser/` app dir). Adapted from
// firefox-wasm/demo/chrome/src/chrome-fs.ts (MPL-2.0); the only difference is
// that the tar bytes come from proxyfox.html instead of a fetch().

const textDecoder = new TextDecoder();

export const REQUIRED_FILES = [
  'fonts/LiberationSans-Regular.ttf',
  'browser/fonts/LiberationSans-Regular.ttf',
  'browser/chrome.manifest',
  'chrome/pdfjs/content/PdfjsContextMenu.sys.mjs',
];

function parseTarString(bytes, start, length) {
  let end = start;
  const max = start + length;
  while (end < max && bytes[end] !== 0) end++;
  return textDecoder.decode(bytes.subarray(start, end));
}

function parseTarSize(bytes, start) {
  const first = bytes[start];
  if (first & 0x80) {
    let size = first & 0x7f;
    for (let i = start + 1; i < start + 12; i++) size = size * 256 + bytes[i];
    return size;
  }
  const raw = parseTarString(bytes, start, 12).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function parsePax(data) {
  const text = textDecoder.decode(data);
  const out = {};
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(' ', i);
    if (space < 0) break;
    const length = Number.parseInt(text.slice(i, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, i + length - 1);
    const eq = record.indexOf('=');
    if (eq >= 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return out;
}

function tarName(bytes, offset) {
  const name = parseTarString(bytes, offset, 100);
  const prefix = parseTarString(bytes, offset + 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function isEmptyBlock(bytes, offset) {
  for (let i = offset; i < offset + 512; i++) if (bytes[i] !== 0) return false;
  return true;
}

function addToTree(dirs, parts, isDir) {
  let dir = '';
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    let children = dirs.get(dir);
    if (!children) {
      children = new Set();
      dirs.set(dir, children);
    }
    children.add(parts[i]);
    if (isLast && !isDir) break;
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
    if (isLast && !dirs.has(dir)) dirs.set(dir, new Set());
  }
}

export function indexTar(bytes) {
  const files = new Map();
  const dirs = new Map([['', new Set()]]);
  let offset = 0;
  let pax;
  let longName;
  while (offset + 512 <= bytes.length && !isEmptyBlock(bytes, offset)) {
    const type = String.fromCharCode(bytes[offset + 156] || 0);
    const size = parseTarSize(bytes, offset + 124);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new Error('chrome-assets: truncated tar archive');
    const data = bytes.subarray(dataStart, dataEnd);
    const name = (pax?.path ?? longName ?? tarName(bytes, offset)).replace(/^\.\//, '');
    pax = undefined;
    longName = undefined;
    const parts = name.split('/').filter(Boolean);
    if (name.startsWith('/') || parts.includes('..')) throw new Error(`chrome-assets: unsafe tar path ${name}`);
    if (type === 'x') pax = parsePax(data);
    else if (type === 'L') longName = parseTarString(data, 0, data.length);
    else if (parts.length && (type === '0' || type === '\0' || type === '')) {
      files.set(parts.join('/'), data);
      addToTree(dirs, parts, false);
    } else if (parts.length && type === '5') addToTree(dirs, parts, true);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return { files, dirs };
}

const normalizePath = (p) => p.split('/').filter(Boolean).join('/');

export function makeTarProvider(index) {
  return {
    async stat(path) {
      const p = normalizePath(path);
      const file = index.files.get(p);
      if (file) return { size: file.byteLength, isDir: false };
      if (index.dirs.has(p)) return { size: 0, isDir: true };
      return null;
    },
    async readdir(path) {
      const children = index.dirs.get(normalizePath(path));
      if (!children) throw new Error(`chrome-assets: no such directory ${path}`);
      return [...children];
    },
    async readFile(path) {
      const file = index.files.get(normalizePath(path));
      if (!file) throw new Error(`chrome-assets: no such file ${path}`);
      return file;
    },
  };
}
