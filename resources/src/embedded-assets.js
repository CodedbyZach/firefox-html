// Live bindings that stand in for the three build-time asset imports of the
// official loader (firefox-wasm/gecko.js/js/index.ts):
//
//   import geckoSource  from '../wasm/gecko.js?source';       -> geckoGlueSource
//   import geckoDataZst from '../wasm/gecko.data.zst?inline'; -> geckoDataZstUrl
//   import assets       from '../wasm/gecko-assets.json';     -> geckoAssetsMeta
//
// pack.mjs resolves those specifiers to `export { X as default } from` this
// module, so index.ts simply sees the values app.js decoded from the Base64
// blocks embedded in proxyfox.html. index.ts only reads them inside
// Gecko#init(), after provideEngineAssets().
//
// Two more hand-overs, which speed-loader.mjs makes index.ts take (each once):
// gecko.data's compressed bytes, so the loader doesn't fetch a blob URL for them,
// and the engine module compiled while the launch page was open.

export let geckoGlueSource = '';
export let geckoDataZstUrl = '';
export let geckoAssetsMeta = { dataCompressed: true, dataSize: 0, wasmCompressed: false, wasmSize: 0 };
let dataZstBytes = null;
let warmModule = null;

export function provideEngineAssets({ glueSource, dataZstUrl = '', dataZstBytes: bytes = null, meta }) {
  geckoGlueSource = glueSource;
  geckoDataZstUrl = dataZstUrl;
  dataZstBytes = bytes;
  geckoAssetsMeta = meta;
}

/** A Promise of the compiled engine module (or of null if compiling it failed). */
export function provideWarmModule(promise) {
  warmModule = promise;
}

export function takeDataZstBytes() {
  const b = dataZstBytes;
  dataZstBytes = null;
  return b;
}

export function takeWarmModule() {
  const m = warmModule;
  warmModule = null;
  return m;
}
