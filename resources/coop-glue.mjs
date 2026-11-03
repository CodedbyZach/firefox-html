// Pack-time patches that let the emscripten glue (gecko.js) run every pthread on
// the page thread when Workers cannot share memory (src/coop.js). Each patch is an
// exact match against emscripten 6.0.1 output; packing fails if one is missing.
// With no window.__geckoCoop (a cross-origin-isolated page) the glue behaves as
// built.

const COOP = 'typeof __geckoCoop != "undefined" && __geckoCoop.active';

const PATCHES = [
  {
    name: 'async pthread instantiation',
    from: '    var instance = new WebAssembly.Instance(wasmModule, getWasmImports());\n',
    to: `    var instance = (${COOP}) ? await WebAssembly.instantiate(wasmModule, getWasmImports()) : new WebAssembly.Instance(wasmModule, getWasmImports());\n`,
  },
  {
    name: 'run after async instantiation',
    from: '        createWasm();\n        run();\n',
    to: `        if (${COOP}) createWasm().then(() => run(), (e) => { err(\`worker: instantiation failed: \${e}\`); throw e; });\n` +
      '        else {\n          createWasm();\n          run();\n        }\n',
  },
  {
    name: 'in-page Workers',
    from: '    worker = new Worker(pthreadMainJs, {\n',
    to: `    worker = new (${COOP} ? __geckoCoop.Worker : Worker)(pthreadMainJs, {\n`,
  },
  {
    name: 'smaller warm pool',
    from: '    var pthreadPoolSize = 20;\n',
    to: `    var pthreadPoolSize = (${COOP}) ? __geckoCoop.poolSize : 20;\n`,
  },
  {
    name: 'suspending wait import',
    re: /(\/\*\* @export \*\/ _emscripten_coop_wait: )(\w+),/,
    to: '$1new WebAssembly.Suspending($2),',
  },
  {
    name: 'suspending yield import',
    re: /(\/\*\* @export \*\/ _emscripten_coop_yield: )(\w+),/,
    to: '$1new WebAssembly.Suspending($2),',
  },
  {
    name: 'export call depth',
    from: '    wasmExports = applySignatureConversions(wasmExports);\n',
    to: '    wasmExports = applySignatureConversions(wasmExports);\n' +
      `    if (${COOP}) wasmExports = __geckoCoop.wrapExports(wasmExports, coopCtx);\n`,
  },
  {
    name: 'table call depth',
    from: 'var getWasmTableEntry = funcPtr => {\n' +
      '  var func = wasmTableMirror[funcPtr];\n' +
      '  if (!func) {\n' +
      '    /** @suppress {checkTypes} */ wasmTableMirror[funcPtr] = func = wasmTable.get(funcPtr);\n' +
      '  }\n' +
      '  /** @suppress {checkTypes} */ assert(wasmTable.get(funcPtr) == func, "table mirror is out of date");\n' +
      '  return func;\n' +
      '};\n',
    to: 'var getWasmTableEntry = funcPtr => {\n' +
      '  var func = wasmTableMirror[funcPtr];\n' +
      '  if (!func) {\n' +
      '    func = wasmTable.get(funcPtr);\n' +
      `    if (func && ${COOP}) func = __geckoCoop.wrapFunction(func, coopCtx);\n` +
      '    wasmTableMirror[funcPtr] = func;\n' +
      '  }\n' +
      '  return func;\n' +
      '};\n',
  },
  {
    name: 'raw promising thread entry',
    from: '  var result = WebAssembly.promising(getWasmTableEntry(ptr))(arg);\n',
    to: '  var result = WebAssembly.promising(wasmTable.get(ptr))(arg);\n',
  },
  {
    name: 'direct proxied calls',
    from: '/** @type{function(number, (number|boolean), ...number)} */ var proxyToMainThread = (funcIndex, emAsmAddr, proxyMode, ...callArgs) => {\n',
    to: '/** @type{function(number, (number|boolean), ...number)} */ var proxyToMainThread = (funcIndex, emAsmAddr, proxyMode, ...callArgs) => {\n' +
      `  if (${COOP}) return __geckoCoop.callOnMain(funcIndex, emAsmAddr, _pthread_self(), proxyMode, callArgs);\n`,
  },
  {
    name: 'main-thread receiver',
    re: /\nvar proxiedFunctionTable = \[[^\n]*\];\n/,
    to: (m) => m +
      `if (!ENVIRONMENT_IS_PTHREAD && ${COOP}) __geckoCoop.mainReceive = (funcIndex, emAsmAddr, callingThread, args) => {\n` +
      '  var func = emAsmAddr ? ASM_CONSTS[emAsmAddr] : proxiedFunctionTable[funcIndex];\n' +
      '  PThread.currentProxiedOperationCallerThread = callingThread;\n' +
      '  try {\n' +
      '    return func(...args);\n' +
      '  } finally {\n' +
      '    PThread.currentProxiedOperationCallerThread = 0;\n' +
      '  }\n' +
      '};\n',
  },
  {
    name: 'shared memory registration',
    from: 'function updateMemoryViews() {\n  var b = wasmMemory.buffer;\n',
    to: 'function updateMemoryViews() {\n' +
      `  if (${COOP}) __geckoCoop.setMemory(wasmMemory);\n` +
      '  var b = wasmMemory.buffer;\n',
  },
  {
    name: 'hot clock loop detector',
    from: 'function _clock_time_get(clk_id, ignored_precision, ptime) {\n',
    to: 'function _clock_time_get(clk_id, ignored_precision, ptime) {\n' +
      `  if (${COOP}) __geckoCoop.clockCall();\n`,
  },
  {
    name: 'core count',
    re: /var _emscripten_num_logical_cores = \(\) => navigator\["hardwareConcurrency"\];\n/,
    to: `var _emscripten_num_logical_cores = () => (${COOP}) ? __geckoCoop.cores : navigator["hardwareConcurrency"];\n`,
  },
];

export const COOP_MARKER = '__geckoCoop.callOnMain(';

export function patchGlueForCoop(src) {
  if (src.includes(COOP_MARKER)) return src;
  for (const p of PATCHES) {
    if (p.re) {
      if (!p.re.test(src)) throw new Error(`coop-glue: "${p.name}" call site not found in gecko.js (emscripten output changed?)`);
      src = src.replace(p.re, p.to);
    } else {
      const n = src.split(p.from).length - 1;
      if (n !== 1) throw new Error(`coop-glue: "${p.name}" call site found ${n} times in gecko.js (expected 1)`);
      src = src.replace(p.from, () => p.to);
    }
  }
  return src;
}
