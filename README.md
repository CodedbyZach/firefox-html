# firefox.html

`firefox.html` is one file that contains the real Gecko engine and Firefox front-end from
[HeyPuter/firefox-wasm](https://github.com/HeyPuter/firefox-wasm), built from source and embedded as Base64.
Double-click it: Firefox starts inside the page. Nothing to install, run or serve.

| File | Purpose |
| --- | --- |
| `firefox.html` | The single-file browser (80,325,334 bytes). |
| `build.sh` | Reproducible build on Linux (Ubuntu 24.04). |
| `build.ps1` | The same build from PowerShell. On Windows it runs `build.sh` inside WSL 2; on Linux it calls it directly. |
| `resources/` | What the build scripts use: the packer, the page source (`src/`) and the engine patches (`patches/`). |

## Report

| Question | Answer |
| --- | --- |
| Did the real Firefox engine build? | Yes. Gecko 153.0a1 compiled with emscripten 6.0.1 and Rust 1.95.0, plus the two patches in `resources/patches`. Build ID `20261103131955`. |
| Final HTML size | 80,325,334 bytes (76.6 MiB). |
| Does it work from `file://`? | Yes. Opened from disk with no browser flags, Firefox boots in about 5 to 7 s (Chrome 153). |
| Does it require a local server? | No. Served from a web server it also works, with or without the two COOP/COEP headers. With them it uses real multi-threading. |
| Which features work? | See "Tested" below. |

## How it runs from a file

Gecko is multi-threaded: 40 to 55 pthreads share one block of WebAssembly memory. Normally each
thread is a Web Worker, and browsers only let a page hand its shared memory to Workers when the page is
cross-origin isolated, which a file opened from disk never is. So when that hand-off isn't allowed, this
build doesn't use Workers at all:

- **Every thread runs on the page itself.** Each thread is its own instance of the engine module over the
  same memory, passed by reference, so the browser's rule never comes into play.
- **Threads take turns.** When one has to wait (a lock, a condition variable, a sleep, a socket), it
  suspends with WebAssembly stack switching (JSPI) and another thread continues. A thread that runs for
  more than 20 ms yields at its next clock read, the way an operating system would preempt it.
- **Nothing in between can block a switch.** Stack switching can't suspend through JavaScript, so three
  places where Gecko's calls passed through JavaScript are now pure WebAssembly:
  - xptcall, both directions, using thunks generated from Gecko's XPT data at build time;
  - setjmp/longjmp, using native wasm exceptions;
  - calls that emscripten used to proxy to the main thread.
- **Cheap when idle.** Repainting backs off when nothing on screen changes, and the engine's command
  loop sleeps until there is work.

When the page *is* cross-origin isolated (served with the two headers), the same file uses real Workers
on all CPU cores instead.

## Tested

Chrome 153 (headless), `firefox.html` opened as `file://` with no command-line flags, so not cross-origin isolated:

- **Engine:** the real one. It boots in 5.2 to 6.7 s on this 4-core machine with 0 Web Workers; about
  50 engine threads take turns on the page thread.
- **Firefox interface:** tabs, a second tab, the address bar (typing with real key events, Enter
  navigates), back/forward, `about:robots`, `about:mozilla`, `about:license`.
- **Pages:** a `data:` page whose scripts reported Gecko-only values (`mozInnerScreenX`,
  `-moz-appearance`, Firefox 153 user agent). An `http://` page loaded through Gecko's own network stack
  via a local WISP relay, and Gecko rendered its CSS, canvas and PNG image.
- **Responsiveness:** after boot a page timer fires within a few ms. While booting, the page can pause
  for up to about 1.5 s at a time.
- **Idle cost:** about 14% of one CPU core and 1.5 GB of memory with Firefox open and idle.
- **Clean runs:** no page errors. The only requests were the file itself and its own `blob:` URLs (plus
  the WISP relay when one was set).
- **GPU mode** (off by default): works, with the same `<canvas>` red/blue swap as in the served build.
- **Served with COOP/COEP** (multi-threaded): boots with 42 Workers, `about:robots` loads, 0 console
  errors.

**Doesn't work / limitations:**

- Slower than the multi-threaded mode, because everything shares one CPU core.
- The New Tab page is blank.
- From `file://` the profile lives in memory (browser storage for files is limited), so cookies and
  history are gone after a reload. Served over http(s), the profile is stored in OPFS.
- File pickers, Save As and playback-speed changes are stubbed out in this engine build.
- Websites need a WISP relay, because a page can't open network connections itself. TLS still happens
  inside Gecko. Nothing remote is used by default: enter a relay under Options, use the opt-in button
  for the official demo's public relay, or bake one in with `WISP_URL=wss://relay/ ./build.sh pack`.
  The button accepts the relay address as plain text, quoted, or in JSON, as `ws(s)://` or
  `http(s)://`. If it finds no address, it quotes the start of the answer.

**Not tested:**

- Firefox or Safari as the host browser. Only Chromium is available on the build machine. The page
  needs WebAssembly JSPI and says so if the browser lacks it; Chrome and Edge have it from version 137.
- The real public relay behind the Options button: the build machine can't reach it. The button was
  tested against a stand-in answer pointing at a local relay, and Firefox then loaded a site through it.
- Real websites (the build machine's network blocks them).
- Audio and video.
- `build.ps1` on real Windows. It was run under PowerShell 7 with a simulated WSL.

**Sharing on Discord:** the file is 76.6 MiB. Discord's upload limit without Nitro is 10 MB, so post it
with Nitro (which allows larger uploads) or share a link from a file host. The engine alone is
37 MB compressed, so a working build can't get under 10 MB.

## Building an update

### Linux (Ubuntu 24.04, about 35 GB of disk, 16 GB of RAM)

```bash
./build.sh
```

| Stage | What it does |
| --- | --- |
| `deps` | apt packages (including Node.js), Rust 1.95.0 with `rust-src` and `wasm32-unknown-emscripten`, cbindgen 0.29.4, pnpm |
| `clone` | Clones firefox-wasm at the pinned commit into `work/` |
| `engine` | Runs upstream's `make emsdk firefox vendor`, applies `resources/patches`, then `make web` and `make chrome-assets` |
| `pack` | Writes `firefox.html` |

`./build.sh pack` alone re-packs. `FIREFOX_WASM_REF=<commit>` builds another upstream version; if the
patches no longer apply to it, the build stops and says which one.

### Windows (PowerShell)

1. Once, in an administrator PowerShell: `wsl --install -d Ubuntu-24.04`. Open Ubuntu once to create
   your Linux user.
2. On a 16 GB PC, put this in `%UserProfile%\.wslconfig`, then run `wsl --shutdown`:
   ```
   [wsl2]
   memory=12GB
   swap=16GB
   ```
3. Run `powershell -ExecutionPolicy Bypass -File .\build.ps1`, or for example `.\build.ps1 pack` for
   one stage.

### The engine patches (`resources/patches`)

- **`gecko.patch`** (Gecko):
  - `xptcodegen.py` also emits typed WebAssembly thunks for every XPCOM method signature (93 for
    calls into C++, 308 for JS-implemented interfaces).
  - `xptcinvoke_wasm.cpp` and `xptcstubs_wasm.cpp` use those thunks and keep the old JavaScript path as
    a fallback for any signature the table lacks.
- **`firefox-wasm.patch`** (the embedder and its final link):
  - `src/coop-threads.c` replaces emscripten's futex wait/wake, `sched_yield`, musl's timed wait and
    `clock_gettime`. Outside single-thread mode they behave exactly like emscripten's.
  - `lib/coop-threads.js` provides the JavaScript side.
  - `gen-coop-sjlj.py` generates wasm-native `invoke_*` wrappers.
  - `embed-xul.cpp` and `embed-init.cpp` wake the engine's command loop when work arrives, so it doesn't
    have to poll.

The page side is in `resources/`:

- `src/coop.js`: the scheduler and the in-page workers.
- `coop-glue.mjs`: pack-time edits to the emscripten glue, each an exact match that stops the pack if
  emscripten's output changes.
- `coop-loader.mjs`: the repaint backoff in upstream's loader.

### What the build does (phases 1 to 4)

- **Upstream build:** `make web` is the `libxul` target. It runs `mach build`, then
  `relink-engine-r.sh`, then `mach build` again, then `build-lib.sh` (the emcc link to
  `gecko.js`/`gecko.wasm`/`gecko.data`), then rspack.
- **The one build error:** the first `mach build` pass ends with
  `wasm-ld ... failed (received SIGSEGV)` on `libxul.so`. That is a known emscripten 6.0.1 crash, and
  upstream's own relink step fixes it.
- **Three options added** on top of upstream's mozconfig (how it builds, not what it builds):
  - `--disable-bootstrap`: use local tools instead of Mozilla's toolchain downloads.
  - `--disable-debug-symbols`: 4 GB build folder instead of 26 GB.
  - `--disable-cargo-incremental`: skip Rust caches that only help rebuilds.
- **Runtime files:**
  - `gecko.js` (glue): the main script, and also what every thread runs.
  - `gecko.wasm`: the engine.
  - `gecko.data`: the minimal GRE.
  - `chrome-assets.tar`: the Firefox front-end, 7,356 files.
- **The single file:** the four assets are Base64 blocks with SHA-256 hashes. The page decodes them,
  turns them into Blob URLs (glue, wasm, data) and serves the front-end from memory. Then upstream's
  loader (`gecko.js/js/index.ts`, with the repaint patch) boots the engine and opens
  `chrome://browser/content/browser.xhtml`.
- **Communication:** the page and engine talk through a command mailbox in shared memory. Frames are
  painted into a buffer the page draws, or through WebGL2 in GPU mode. Files go through WasmFS
  providers. Networking goes from Necko sockets to the patched WasmFS socket layer, then to a WISP
  WebSocket.

## Licenses

Gecko, the Firefox front-end and firefox-wasm are MPL-2.0. The bundled wisp-js client is AGPL-3.0,
zstddec is MIT, and the icons are Lucide (ISC). The full texts are at the bottom of `firefox.html`, and
Gecko's third-party licenses are at `about:license`. This is an unofficial build; Firefox is a
trademark of the Mozilla Foundation.
