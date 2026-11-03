// Live bindings that stand in for the three build-time asset imports of the
// official loader (firefox-wasm/gecko.js/js/index.ts):
//
//   import geckoSource  from '../wasm/gecko.js?source';       -> geckoGlueSource
//   import geckoDataZst from '../wasm/gecko.data.zst?inline'; -> geckoDataZstUrl
//   import assets       from '../wasm/gecko-assets.json';     -> geckoAssetsMeta
//
// pack.mjs resolves those specifiers to `export { X as default } from` this
// module, so index.ts is bundled byte-for-byte unmodified and simply sees the
// values app.js decoded from the Base64 blocks embedded in firefox.html.
// index.ts only reads them inside Gecko#init(), after provideEngineAssets().

export let geckoGlueSource = '';
export let geckoDataZstUrl = '';
export let geckoAssetsMeta = { dataCompressed: true, dataSize: 0, wasmCompressed: false, wasmSize: 0 };

export function provideEngineAssets({ glueSource, dataZstUrl, meta }) {
  geckoGlueSource = glueSource;
  geckoDataZstUrl = dataZstUrl;
  geckoAssetsMeta = meta;
}
