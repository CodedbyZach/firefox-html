// Load-time patches to the engine's JavaScript glue (gecko.js, embedded exactly as the engine
// build produced it). app.js applies them to the decoded glue before anything runs it, so
// the page thread, every engine Worker and single-thread mode all get the same glue; the
// embedded bytes and their SHA-256 stay as built. pack.mjs checks at pack time that every
// patch still applies. Each `from` is an exact match against that glue, found exactly once
// (or `count` times, all replaced).

export const GLUE_PATCHES = [
  {
    // Gecko's low-resolution clock (TimeStamp::NowLoRes, PR_IntervalNow: socket and timer
    // timeouts) is a shared-memory word the page refreshed with setInterval. A hidden tab
    // runs the page's timers once a second at most (once a minute after 5 minutes), so while
    // you were in another tab Gecko's clock stood still and then jumped. A Worker sleeping on
    // Atomics.wait isn't throttled; it writes the word every 4 ms (what the page timer managed
    // in a visible tab) instead, and the timer is only the fallback.
    name: 'clock keeps running in a background tab',
    from: '    tick();\n    setInterval(tick, 1);\n  } catch (e) {}\n}',
    to: '    tick();\n' +
      '    try {\n' +
      '      var clockWorker = new Worker(URL.createObjectURL(new Blob(["onmessage = function (e) {' +
      ' var v = new BigInt64Array(e.data.buf, e.data.ptr, 1), nap = new Int32Array(new SharedArrayBuffer(4));' +
      ' for (;;) { var t = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));' +
      ' if (t > Atomics.load(v, 0)) Atomics.store(v, 0, t); Atomics.wait(nap, 0, 0, 4); } };"],' +
      ' { type: "text/javascript" })));\n' +
      '      clockWorker.postMessage({ buf: wasmMemory.buffer, ptr: ptr });\n' +
      '      globalThis.__geckoCoarseClockWorker = clockWorker;\n' +
      '    } catch (e) {\n' +
      '      setInterval(tick, 1);\n' +
      '    }\n' +
      '  } catch (e) {}\n}',
  },
  {
    // When the relay's WebSocket closed (the relay restarting, an idle timeout while you
    // were away, a network blip, sleep), the dead connection stayed in WISP.conn, so every
    // later connect waited on it forever and no site loaded until the page was reloaded.
    name: 'relay reconnects after it drops',
    from: '    var teardown = function(errno) {\n      conn.ready = false;\n',
    to: '    var teardown = function(errno) {\n      conn.ready = false;\n' +
      '      if (WISP.conn === conn) WISP.conn = null; // the next connect opens a new relay connection\n',
  },
  {
    // Video: ask for the browser's software decoder first. Its frames are I420 in memory,
    // which onFrame copies into the engine in one step; a GPU decoder's frames are read back
    // and converted pixel by pixel on the page thread (11.6 ms per 1080p frame). If the
    // software decoder can't take the stream (HEVC, say), the default decoder takes over
    // with the chunks fed so far.
    name: 'video decoder prefers software (I420 frames)',
    from: '    var dec = new VideoDecoder({\n' +
      '      output: function(frame) {\n' +
      '        wcRT.onFrame(reg, frame);\n' +
      '      },\n' +
      '      error: function(e) {\n' +
      '        console.warn("[webcodecs] decoder error:", e && e.message ? e.message : e);\n' +
      '        wcRT.setError(reg);\n' +
      '      }\n' +
      '    });\n' +
      '    dec.configure(config);\n' +
      '    reg.decoder = dec;\n',
    to: '    reg.softConfig = Object.assign({}, config, { hardwareAcceleration: "prefer-software" });\n' +
      '    reg.soft = true;\n' +
      '    reg.replay = [];\n' +
      '    var makeDecoder = function() {\n' +
      '      return new VideoDecoder({\n' +
      '        output: function(frame) {\n' +
      '          reg.replay = null;\n' +
      '          wcRT.onFrame(reg, frame);\n' +
      '        },\n' +
      '        error: function(e) {\n' +
      '          if (reg.soft && reg.replay && !reg.dead) {\n' +
      '            reg.soft = false;\n' +
      '            var chunks = reg.replay;\n' +
      '            reg.replay = null;\n' +
      '            try {\n' +
      '              reg.decoder = makeDecoder();\n' +
      '              reg.decoder.configure(reg.config);\n' +
      '              for (var i = 0; i < chunks.length; i++) reg.decoder.decode(chunks[i]);\n' +
      '              console.warn("[webcodecs] software decoder unavailable for " + reg.config.codec + "; using the default one");\n' +
      '              return;\n' +
      '            } catch (e2) {}\n' +
      '          }\n' +
      '          console.warn("[webcodecs] decoder error:", e && e.message ? e.message : e);\n' +
      '          wcRT.setError(reg);\n' +
      '        }\n' +
      '      });\n' +
      '    };\n' +
      '    var dec = makeDecoder();\n' +
      '    dec.configure(reg.softConfig);\n' +
      '    reg.decoder = dec;\n',
  },
  {
    name: 'video decoder keeps the chunks until it has shown a frame',
    from: '    var chunk = new EncodedVideoChunk({\n' +
      '      type: isKey ? "key" : "delta",\n' +
      '      timestamp: ts,\n' +
      '      data: (growMemViews(), HEAPU8).slice(dataPtr, dataPtr + dataLen)\n' +
      '    });\n' +
      '    reg.decoder.decode(chunk);\n',
    to: '    var chunk = new EncodedVideoChunk({\n' +
      '      type: isKey ? "key" : "delta",\n' +
      '      timestamp: ts,\n' +
      '      data: (growMemViews(), HEAPU8).slice(dataPtr, dataPtr + dataLen)\n' +
      '    });\n' +
      '    reg.decoder.decode(chunk);\n' +
      '    if (reg.replay && reg.replay.push(chunk) > 300) reg.replay = null;\n',
  },
  {
    name: 'video decoder reset keeps the decoder it uses',
    from: '  Atomics.store((growMemViews(), HEAP32), ci + wcOff.WC_ERROR, 0);\n' +
      '  reg.pending = Promise.resolve();\n' +
      '  try {\n' +
      '    reg.decoder.configure(reg.config);\n',
    to: '  Atomics.store((growMemViews(), HEAP32), ci + wcOff.WC_ERROR, 0);\n' +
      '  reg.pending = Promise.resolve();\n' +
      '  try {\n' +
      '    reg.decoder.configure(reg.soft ? reg.softConfig : reg.config);\n',
  },
  {
    // A website's WebGL runs on a real WebGL context of this browser. glGetString kept one
    // answer per thread, not per context, so after a page made a WebGL 1 canvas every
    // later WebGL 2 canvas was told "OpenGL ES 2.0" and Firefox refused it ("WebGL 2
    // requires support for the following features: prim_restart_fixed"). The answers are
    // now kept per WebGL version.
    name: 'WebGL 2 works after a WebGL 1 canvas (GL strings per WebGL version)',
    from: 'function _emscripten_glGetString(name_) {\n  var ret = GL.stringCache[name_];\n',
    to: 'function _emscripten_glGetString(name_) {\n' +
      '  var stringKey = (GL.currentContext && GL.currentContext.version >= 2 ? "2:" : "1:") + name_;\n' +
      '  var ret = GL.stringCache[stringKey];\n',
  },
  {
    name: 'WebGL 2 works after a WebGL 1 canvas (store)',
    from: '    GL.stringCache[name_] = ret;\n',
    to: '    GL.stringCache[stringKey] = ret;\n',
  },
  {
    // GPU mode: WebRender keeps BGRA images in RGBA textures and swaps red and blue back
    // in its shaders (swizzleColor0, set per draw by uColor0Swizzle). The compositing
    // shader didn't, so anything shown as its own layer (a website's <canvas>, 2D or
    // WebGL) came out with red and blue swapped. WebRender sets the uniform when it binds
    // an image (1 for BGRA images, 0 for its own render targets), so the rest is unchanged.
    name: 'GPU mode: canvas colors (composite shader swaps BGRA like the image shaders)',
    from: '  try { source = __wrHoistVaryings(source); } catch(e){}\n',
    to: '  try { source = __wrHoistVaryings(source); } catch(e){}\n' +
      '  if (/^\\/\\/ shader: composite\\b/m.test(source) && /^#define WR_FRAGMENT_SHADER\\b/m.test(source) &&\n' +
      '      source.indexOf("vec4 swizzleColor0(") >= 0)\n' +
      '    source = source.replace("vec4 texel = TEX_SAMPLE(sColor0, uv);", "vec4 texel = swizzleColor0(TEX_SAMPLE(sColor0, uv));");\n',
  },
  // Memory above 2 GB. The engine's heap can grow to 4 GB (uBlock Origin's first setup takes
  // it to about 3 GB; a big game can too), but the glue's own JavaScript for the relay, the
  // profile, images, video, audio and websites' WebAssembly took the engine's pointers as
  // signed 32-bit numbers: above 2 GB they turned negative, and .slice() then read the wrong
  // bytes (or none) and the shared control blocks were written at negative indexes. These read
  // them as unsigned (count: the number of sites each replaces, all of them).
  {
    name: 'memory above 2 GB: control blocks indexed unsigned',
    count: 15,
    from: 'ctrl >> 2',
    to: 'ctrl >>> 2',
  },
  {
    name: 'memory above 2 GB: codec descriptions',
    count: 2,
    from: '.slice(descPtr, descPtr + descLen)',
    to: '.slice(descPtr >>> 0, (descPtr >>> 0) + descLen)',
  },
  {
    name: 'memory above 2 GB: video, audio and image data',
    count: 4,
    from: '.slice(dataPtr, dataPtr + dataLen)',
    to: '.slice(dataPtr >>> 0, (dataPtr >>> 0) + dataLen)',
  },
  {
    name: 'memory above 2 GB: profile writes',
    from: '.slice(dataPtr, dataPtr + len)',
    to: '.slice(dataPtr >>> 0, (dataPtr >>> 0) + len)',
  },
  {
    name: 'memory above 2 GB: relay sends and websites\' WebAssembly',
    count: 2,
    from: '.slice(ptr, ptr + len)',
    to: '.slice(ptr >>> 0, (ptr >>> 0) + len)',
  },
  {
    name: 'memory above 2 GB: file reads',
    from: '.slice(buf, buf + length)',
    to: '.slice(buf >>> 0, (buf >>> 0) + length)',
  },
  {
    name: 'memory above 2 GB: file sizes',
    from: '[(outSize >> 2) + 1 >>> 0]',
    to: '[(outSize >>> 2) + 1 >>> 0]',
  },
  {
    name: 'memory above 2 GB: XPCOM call arguments',
    from: '[(off >> 2) + 1 >>> 0] = 0;',
    to: '[(off >>> 2) + 1 >>> 0] = 0;',
  },
];

/** Applies GLUE_PATCHES; returns the patched glue and the names of patches that didn't apply. */
export function patchGlue(src) {
  const missing = [];
  for (const p of GLUE_PATCHES) {
    const want = p.count ?? 1;
    const n = src.split(p.from).length - 1;
    if (n !== want) {
      missing.push(`${p.name} (site found ${n} times, expected ${want})`);
      continue;
    }
    src = src.split(p.from).join(p.to);
  }
  return { src, missing };
}
