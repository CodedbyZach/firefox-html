# proxyfox.html

Made by CodedbyZach (zmandem7).

`proxyfox.html` is one HTML file that runs the real Firefox (the Gecko engine and the Firefox
interface, compiled to WebAssembly) inside a browser tab. Websites load through a WISP relay.

Live at **https://proxyfox.codedbyzach.com**

## Run it

You need Chrome or Edge 137 or newer.

- **From the website:** open https://proxyfox.codedbyzach.com and click **Launch Firefox**. On the
  website it runs multi-threaded and keeps your Firefox profile (cookies, history) between visits.
  Click **Install app** (or the install icon in the address bar) to open it from your device next
  time, offline too.
- **As a file:** download `proxyfox.html`, double-click it and click **Launch Firefox**. A file runs
  single-threaded (slower) and forgets the profile when you close it.
- **Quitting:** Ctrl+Q or Exit in Firefox's menu goes back to the launch page. Launch opens Firefox
  again.

### Options

On the launch page, under **Options**:

| Option | What it does |
| --- | --- |
| Resolution | Draws Firefox with more pixels, from your screen's size up to 4K. Above Current it turns on GPU acceleration. |
| GPU acceleration | Draws with your GPU through WebGL2. Smoother, but `<canvas>` content on websites shows red and blue swapped. |
| Block Firefox's background calls to Mozilla | Keeps Firefox from contacting Mozilla's services on its own. On by default. |
| Save websites' files between visits | Firefox's disk cache (up to 256 MB, in this site's browser storage): sites you visited before load from your device instead of through the relay again. On by default; only on the website running multi-threaded, where the profile is saved. |
| Experimental JS to WASM JIT | Faster JavaScript on some sites, breaks others. Off by default. |
| WISP server | The relay websites load through. Default `wss://itcode.vip/api/`. |
| Open after launch | A page to open when Firefox starts. |

## Host it

Upload `proxyfox.html` to any web host. For the installable app, also upload `sw.js`,
`manifest.webmanifest`, `icons/`, `index.html` and `404.html` next to it.

For multi-threading the page needs two response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- **Apache or cPanel:** add this to `.htaccess`:
  ```apache
  Header set Cross-Origin-Opener-Policy "same-origin"
  Header set Cross-Origin-Embedder-Policy "require-corp"
  AddType application/manifest+json .webmanifest
  ```
- **GitHub Pages behind Cloudflare** (how proxyfox.codedbyzach.com runs): set the DNS record to
  Proxied, set SSL/TLS to Full, and add a Response Header Transform Rule for the hostname that sets
  both headers.

Without the headers it still works, single-threaded.

## Build it

### Page only (about a minute)

Changes to the page (`resources/src`, `resources/*.mjs`) don't need an engine build: the packer
reuses the engine inside the current `proxyfox.html`. You need git and Node.js 18 or newer (on
Windows, run these in WSL):

```bash
./build.sh clone
cd resources && npm install && cd ..
node resources/pack.mjs --engine-from proxyfox.html
```

### Full build (engine included)

This builds Gecko from source. It takes several hours and needs Ubuntu 24.04 (or WSL 2 on Windows),
about 35 GB of disk and 16 GB of RAM.

```bash
./build.sh
```

It runs four stages. You can also run one at a time, for example `./build.sh pack`:

| Stage | What it does |
| --- | --- |
| `deps` | Installs the tools: apt packages, Node.js, Rust 1.95.0, cbindgen and pnpm. |
| `clone` | Clones HeyPuter/firefox-wasm at the pinned commit into `work/`. |
| `engine` | Builds Gecko with the patches in `resources/patches`. |
| `pack` | Writes `proxyfox.html`. |

`WISP_URL=wss://relay.example/ ./build.sh pack` builds with a different default relay.

**On Windows:**

1. Once, in an administrator PowerShell: `wsl --install -d Ubuntu-24.04`. Open Ubuntu once to
   create your Linux user.
2. On a 16 GB PC, put this in `%UserProfile%\.wslconfig`, then run `wsl --shutdown`:
   ```
   [wsl2]
   memory=12GB
   swap=16GB
   ```
3. Run `powershell -ExecutionPolicy Bypass -File .\build.ps1`. It runs the build inside WSL and
   copies `proxyfox.html` back. Add a stage to run just that one, for example `.\build.ps1 pack`.

## Files

| File | What it is |
| --- | --- |
| `proxyfox.html` | The browser, in one file. |
| `sw.js`, `manifest.webmanifest`, `icons/` | The installable app. |
| `index.html`, `404.html` | Send the site's front page, and old links to `firefox.html`, to `proxyfox.html`. |
| `build.sh`, `build.ps1` | The build (Linux, and Windows through WSL). |
| `resources/` | The packer, the page's source (`src/`) and the engine patches (`patches/`). |

## License

Made by CodedbyZach (zmandem7). The code in this repository is licensed under the GNU AGPL 3.0
with one added term: any copy or changed version must keep "Made by CodedbyZach (zmandem7)" visible
on its launch page and in its credits. See [LICENSE](LICENSE).

The engine and the other bundled parts keep their own licenses: Gecko, Firefox and firefox-wasm are
MPL-2.0, the wisp-js client is AGPL-3.0, zstddec is MIT and the Lucide icons are ISC. The full texts
are in the Licenses section at the bottom of `proxyfox.html`. Firefox is a trademark of the Mozilla
Foundation; this is an unofficial build.
