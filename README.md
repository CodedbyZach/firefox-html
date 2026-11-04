# proxyfox.html

`proxyfox.html` is one file that contains the real Gecko engine and Firefox front-end from
[HeyPuter/firefox-wasm](https://github.com/HeyPuter/firefox-wasm), built from source and embedded as Base64.
Double-click it: Firefox starts inside the page. Nothing to install, run or serve. On a website it can
also be installed as an app that opens from the device.

| File | Purpose |
| --- | --- |
| `proxyfox.html` | The single-file browser (80,275,407 bytes). It was called `firefox.html` before. |
| `build.sh` | Reproducible build on Linux (Ubuntu 24.04). |
| `build.ps1` | The same build from PowerShell. On Windows it runs `build.sh` inside WSL 2; on Linux it calls it directly. |
| `resources/` | What the build scripts use: the packer, the page source (`src/`) and the engine patches (`patches/`). |
| `index.html` | The site's front page on GitHub Pages: opens `proxyfox.html`. |
| `404.html` | GitHub Pages' page for missing addresses: sends old links to `firefox.html` on to `proxyfox.html`. |
| `sw.js`, `manifest.webmanifest`, `icons/` | Make the website an installable app that opens from the device (see "Installing it as an app"). Not needed for the file. |

## Report

| Question | Answer |
| --- | --- |
| Did the real Firefox engine build? | Yes. Gecko 153.0a1 compiled with emscripten 6.0.1 and Rust 1.95.0, plus the two patches in `resources/patches`. Build ID `20261103131955`. |
| Final HTML size | 80,275,407 bytes (76.6 MiB). |
| Does it work from `file://`? | Yes. Opened from disk with no browser flags, Firefox is ready about 4 to 5 s after Launch (Chrome 153). |
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
- **Cheap when idle.** Repainting backs off when nothing on screen changes (see "Speed"), and the
  engine's command loop sleeps until there is work.

When the page *is* cross-origin isolated (served with the two headers), the same file uses real Workers
on all CPU cores instead.

## Speed

- **Idle:** when nothing on screen changes and there has been no input for 1.5 s, the page asks the
  engine for a new frame less and less often, down to every 500 ms; any change or input goes back to
  every frame. A frame identical to the one shown isn't drawn again, nothing is drawn while the tab is
  hidden, and GPU mode checks for popups on a timer instead of every frame. On a website
  (multi-threaded) an idle Firefox now costs about 7% of one CPU core instead of 50%; from a file, 3%
  instead of 6%.
- **Launch:** the engine (222 MB of WebAssembly) is compiled in the background while the launch page
  is open, so Launch only has to start it. Clicking Launch a few seconds after the page was ready,
  Firefox was ready 1.1 to 1.4 s sooner on a website and 0.8 s sooner from a file on this machine;
  clicked the moment it's enabled, Launch waits for the rest of the compile. The engine's data
  package is handed over in memory, and decoding starts while the startup checks run.
- **Input:** the canvas position that mouse and touch positions are mapped through is measured once
  and again on resize, not on every mouse move. The page waits for each command with
  `Atomics.waitAsync`, which would wake it the moment the engine signals; this engine build only sets
  the flag, so the page still checks it every 4 ms, as before.
- **Startup log:** while Firefox is open, new lines wait and join the log when the launch page comes
  back. The browser's console gets them right away.

## Hosting it on a website

Multi-threading needs two response headers on `proxyfox.html`:
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.

- **Apache/cPanel:** set them in `.htaccess` (and, for the app, `AddType application/manifest+json .webmanifest`).
- **GitHub Pages** (which can't send headers) **behind Cloudflare:** proxy the DNS record (orange
  cloud), keep SSL/TLS on Full, and add a Response Header Transform Rule for the hostname that sets
  both headers. `index.html` sends the site's root to `proxyfox.html`.
- **Neither:** it still works, single-threaded, with the profile kept in memory. Opened as a file
  (shared on Discord, say), it is always single-threaded.
- **Old links:** `firefox.html` was this file's name before. `404.html` (GitHub Pages) sends that
  address on to `proxyfox.html`, and on a device with the app `sw.js` does, offline too.

### Installing it as an app

On the website `proxyfox.html` is also an installable app (PWA). `sw.js`, a service worker, keeps the
77 MB file in the browser's Cache Storage, so after the first visit it opens from the device instead of
being downloaded again, offline too.

- **Install:** the launch page shows **Install app** when the browser offers it (Chrome and Edge), or
  use the install icon in the address bar. The app opens in its own window.
- **Updates:** every opening asks the site whether `proxyfox.html` changed, with a conditional request:
  an unchanged file costs a "304 Not Modified" and no download. A new build downloads in the background
  and opens next time; the launch page offers **Reload now**.
- **Files:** `sw.js`, `manifest.webmanifest` and `icons/` sit next to `proxyfox.html`. The cached copy
  keeps its COOP/COEP headers, so the app stays multi-threaded. Without these files (a lone
  `proxyfox.html` on a site, or the file opened from disk) the page works as before and just isn't
  installable.
- **The rename:** an app installed while the file was `firefox.html` keeps working. The manifest's `id`
  stays `firefox.html`, so the browser treats it as the same app and updates it in place rather than
  adding a second one; until it picks up the new start address, `sw.js` sends the old one on.
- **Changing `index.html`, the manifest or the icons:** rename `CACHE` in `sw.js` (say to
  `firefox-html-app-v3`). The browser picks up the new `sw.js` a few seconds into the next opening and
  caches the small files again; the `proxyfox.html` already on the device is carried over.

## Tested

Chrome 153 (headless), `proxyfox.html` opened as `file://` with no command-line flags, so not cross-origin isolated:

- **Engine:** the real one. Firefox is ready 4.2 to 4.4 s after Launch on this 4-core machine (the
  engine compiled while the launch page was open), with 0 Web Workers; about 50 engine threads take
  turns on the page thread.
- **Firefox interface:** tabs, a second tab, the address bar (typing with real key events, Enter
  navigates), back/forward, `about:robots`, `about:mozilla`, `about:license`.
- **Pages:** a `data:` page whose scripts reported Gecko-only values (`mozInnerScreenX`,
  `-moz-appearance`, Firefox 153 user agent). An `http://` page loaded through Gecko's own network stack
  via a local WISP relay, and Gecko rendered its CSS, canvas and PNG image.
- **Responsiveness:** after boot a page timer fires within a few ms. While booting, the page can pause
  for up to about 1.5 s at a time.
- **Idle cost:** about 3% of one CPU core and 1.5 GB of memory with Firefox open and idle (6% before
  the changes under "Speed").
- **Clean runs:** no page errors. The only requests were the file itself and its own `blob:` URLs (plus
  the WISP relay when one was set).
- **GPU mode** (off by default): works, with the same `<canvas>` red/blue swap as in the served build.
- **Served with COOP/COEP** (multi-threaded): Firefox is ready 4.0 to 4.7 s after Launch (5.3 to 5.8 s
  before), with 44 to 51 Workers, and costs about 7% of one CPU core while idle (50% before). New tab
  (Ctrl+T) still draws after sitting idle, `about:robots` loads, 0 console errors.
- **Served without headers, like GitHub Pages:** single-threaded, the profile kept in memory, 0 errors.
- **Resolution** (Options, Current up to 4K): Firefox keeps its size and is drawn with more pixels
  (Gecko's device pixel ratio set to the step). On a 125% display, 1080p is 1:1 with the screen and
  visibly sharper than Current; 4K is supersampled. At 1080p, 1440p and 4K it booted in 7 to 9 s, and
  clicks (new tab, the address bar, items inside the app menu and the tab context menu), clicking
  outside an open menu, typing and scrolling all worked. Tested from `file://` and served with
  COOP/COEP, with the window resized before and after launch.
- **Touch:** a finger drag scrolls the page or box under it 1:1 (200 px drag, 200 px scroll), a quick
  swipe flings on, a tap still clicks, a drag that starts on a button doesn't click it, and the page
  around Firefox never moves. Tested with Chromium's real touch input from `file://` (also at a pixel
  ratio of 1.25 with GPU rendering) and served multi-threaded.
- **App (PWA)**, served the way GitHub Pages behind Cloudflare serves it (ETag, Last-Modified,
  `max-age=600`, COOP/COEP): Chrome reports it installable with no errors and fires its install prompt
  (Install app appears and opens it). The first visit downloaded `proxyfox.html` once; the service
  worker's copy came from the HTTP cache. Reopened, the page came from the device and the site only
  answered one 304 (0 bytes): the HTML was read in 0.6 s, the launch page was ready in 2.6 s, still
  cross-origin isolated, and Firefox was ready 4.2 s after Launch with 36 Workers. With the server
  stopped, the site's root still opened it. A changed `proxyfox.html` downloaded in the background
  while the old copy opened, and Reload now opened the new build. A renamed `CACHE` took over within
  seconds without downloading `proxyfox.html` again. From `file://` there is no manifest, service
  worker or Install button.
- **The rename:** with the app installed from the old site (`firefox.html`, `sw.js` with
  `firefox-html-app-v1`), the site was switched to this version. Opening the old address still worked
  from the old copy, the new `sw.js` downloaded `proxyfox.html` in the background and removed the old
  copy, and the page offered Reload now, which opened `proxyfox.html` from the device. Offline,
  `firefox.html?env.X=1` went to `proxyfox.html?env.X=1`; without the app, `404.html` sent
  `firefox.html#x` to `proxyfox.html#x`.
- **Quitting** (Ctrl+Q, the menu's Exit, closing the last tab): a "Firefox closed" message counts down
  3 s, then the launch page comes back; "Keep browsing" cancels. Firefox stays loaded behind it, so
  Launch opens it again in about 60 ms with one fresh tab (three times in a row, no slowdown). A window
  that really closes reloads the page instead. Tested from `file://` (software and GPU) and served
  multi-threaded.

**Doesn't work / limitations:**

- Slower than the multi-threaded mode, because everything shares one CPU core.
- From `file://` a quick swipe sometimes stops where the finger lifts instead of flinging: the page
  thread is busy running the engine, so the swipe's last movements can arrive too late to measure its
  speed (the same in the build before the changes under "Speed"). Served multi-threaded it flings.
- In single-thread mode, reloading the page (F5) and launching again gets slower each time (5, then
  21, then 55 s here): the browser doesn't fully free the previous engine, whose threads are suspended
  in the page. Quitting Firefox doesn't reload, so it avoids this; multi-threaded pages are not
  affected.
- After a quit, the options can only be changed by reloading the page.
- The New Tab page is blank.
- From `file://` the profile lives in memory (browser storage for files is limited), so cookies and
  history are gone after a reload. On a website running multi-threaded, the profile is stored in OPFS;
  single-threaded it stays in memory too (OPFS writes need a real Worker).
- File pickers, Save As and playback-speed changes are stubbed out in this engine build.
- Resolution above Current turns on GPU rendering, with its `<canvas>` color swap: this engine build's
  software renderer paints one pixel per CSS pixel at any pixel ratio (`embed-paint.cpp`). Without
  WebGL2 only Current is offered. Fixing the software renderer needs an engine rebuild.
- Websites load through a WISP relay, because a page can't open network connections itself. The
  default is `wss://itcode.vip/api/`, shown under Options > WISP server, where it can be changed (or
  cleared for local pages only). The page checks the relay when it opens. TLS still happens inside
  Gecko, so HTTPS stays encrypted end to end; plain HTTP pages are visible to the relay.

**Not tested:**

- Firefox or Safari as the host browser. Only Chromium is available on the build machine. The page
  needs WebAssembly JSPI and says so if the browser lacks it; Chrome and Edge have it from version 137.
- The default relay `wss://itcode.vip/api/`: the build machine's network can't reach it. The same path
  was tested with a relay on the build machine, which Firefox loaded a site through. A relay has to
  accept pages opened as files (they connect with `Origin: null`).
- Real websites (the build machine's network blocks them).
- Audio and video.
- `build.ps1` on real Windows. It was run under PowerShell 7 with a simulated WSL.
- Chrome moving an already-installed app to the new start address `proxyfox.html` (it updates installed
  apps' manifests by itself, at most once a day); until then the old address is sent on.
- The app in a real desktop window (the build machine only runs headless Chromium), and the live
  site's own 304 answers (it can't reach the site). A server that answers 200 anyway costs a moment of
  download: the service worker stops it once it sees the same ETag.

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
| `pack` | Writes `proxyfox.html` |

`./build.sh pack` alone re-packs. `FIREFOX_WASM_REF=<commit>` builds another upstream version; if the
patches no longer apply to it, the build stops and says which one.

### Page-only changes (no engine build)

Changes to the page in `resources/src` don't need the engine build: the packer can reuse the engine
inside an existing `proxyfox.html` (or a `firefox.html` from before the rename). Its four engine
assets are copied byte for byte and checked against its SHA-256 manifest. This takes about a minute
and needs only git and Node.js 18+ (on Windows, run it in WSL):

```bash
./build.sh clone
(cd resources && npm install)
node resources/pack.mjs --engine-from proxyfox.html
```

`clone` fetches firefox-wasm itself (small, not the Gecko source) for the loader source. Changes to
`resources/patches` or `resources/coop-glue.mjs` still need the full build.

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
- `coop-loader.mjs`: a hash of every frame and the time of the last input, in upstream's loader.
- `speed-loader.mjs`: the changes under "Speed" in upstream's loader: the repaint policy, skipping
  unchanged frames, the engine compiled in advance (handed over by `src/app.js` through
  `src/embedded-assets.js`), the data package in memory and the measured canvas position.
- `resolution-loader.mjs`: input for the Resolution option in upstream's loader: mouse positions in
  CSS pixels, wheel deltas in device pixels, and presses while a menu is open (above a pixel ratio of
  1 the engine's own "click outside a popup" test mixes the two, so the page does that test).
- `src/touch.js` and `touch-loader.mjs`: touch scrolling. The loader forwards no touch input, so the
  page turns finger drags into scrolling through the engine's wheel path (`touchScroll()`).
- `src/app.js` ("quit"): answers Firefox's quit requests in the chrome window, so quitting returns to
  the launch page with Firefox still loaded (a real quit would leave the engine with no window).

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
  loader (`gecko.js/js/index.ts`, with the pack-time patches above) boots the engine and opens
  `chrome://browser/content/browser.xhtml`.
- **Communication:** the page and engine talk through a command mailbox in shared memory. Frames are
  painted into a buffer the page draws, or through WebGL2 in GPU mode. Files go through WasmFS
  providers. Networking goes from Necko sockets to the patched WasmFS socket layer, then to a WISP
  WebSocket.

## Licenses

Gecko, the Firefox front-end and firefox-wasm are MPL-2.0. The bundled wisp-js client is AGPL-3.0,
zstddec is MIT, and the icons are Lucide (ISC). The full texts are at the bottom of `proxyfox.html`, and
Gecko's third-party licenses are at `about:license`. This is an unofficial build; Firefox is a
trademark of the Mozilla Foundation.
