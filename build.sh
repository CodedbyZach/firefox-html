#!/usr/bin/env bash
# Build proxyfox.html on Linux: the real Gecko engine (HeyPuter/firefox-wasm) compiled to
# WebAssembly with emscripten 6.0.1, then packed into ONE HTML file next to this script.
# On Windows, run build.ps1 instead (it runs this script inside WSL 2).
#
# Host: Ubuntu 24.04 x86_64 (tested). About 35 GB free disk and 16 GB RAM recommended; about
# 1 to 3 hours on 4 cores. Needs internet access to github.com (git), storage.googleapis.com
# (emsdk), static.rust-lang.org, crates.io, registry.npmjs.org and the Ubuntu archive.
#
#   ./build.sh            everything: deps, clone, engine, pack
#   ./build.sh deps       apt packages (incl. Node.js), Rust 1.95.0 (+rust-src, wasm32-unknown-emscripten), cbindgen, pnpm
#   ./build.sh clone      clone firefox-wasm at the pinned commit into work/
#   ./build.sh engine     upstream build: make emsdk firefox vendor, apply resources/patches,
#                         make web, make chrome-assets
#   ./build.sh pack       resources/pack.mjs -> proxyfox.html
#
# Environment: REPO (existing firefox-wasm checkout), FIREFOX_WASM_REF, and WISP_URL (the default
# WISP relay baked into proxyfox.html; wss://itcode.vip/api/ when unset, WISP_URL= for none).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RES="$HERE/resources"
REPO="${REPO:-$HERE/work/firefox-wasm}"
FIREFOX_WASM_URL="https://github.com/HeyPuter/firefox-wasm"
FIREFOX_WASM_REF="${FIREFOX_WASM_REF:-bc69aaa5e2c5388bcf93a43b975b490bb940f4c0}"
RUST_VERSION="1.95.0"
CBINDGEN_VERSION="0.29.4"
LIBCLANG_VERSION="20"
PNPM_VERSION="9.12.0"

step() { printf '\n==> %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"

node_ok() { command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)'; }

preflight() {
  mkdir -p "$(dirname "$REPO")"
  local free_gb ram_gb
  free_gb=$(( $(df --output=avail -k "$(dirname "$REPO")" | tail -1) / 1048576 ))
  ram_gb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1048576 ))
  [ "$free_gb" -ge 35 ] || warn "only ${free_gb} GB free for $(dirname "$REPO"); the build needs about 35 GB"
  [ "$ram_gb" -ge 12 ] || warn "only ${ram_gb} GB RAM; 16 GB is recommended (add swap if the build gets killed)"
}

deps() {
  step "apt packages"
  $SUDO apt-get update
  # clang = HOST_CC/HOST_CXX for Gecko's host tools; libclang-20 = bindgen (emscripten 6's
  # LLVM-23 libc++ headers need clang >= 19 builtins; Ubuntu's default 18 fails).
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential clang git curl ca-certificates python3 python3-venv unzip zstd rsync m4 \
    pkg-config libpulse-dev "libclang-${LIBCLANG_VERSION}-dev"
  if ! node_ok; then
    step "Node.js (Ubuntu package)"
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs npm
    node_ok || die "Node.js 18+ is required; install it (https://nodejs.org) and rerun"
  fi
  if ! command -v pnpm >/dev/null; then
    step "pnpm ${PNPM_VERSION}"
    { corepack enable 2>/dev/null && corepack prepare "pnpm@${PNPM_VERSION}" --activate; } || $SUDO npm install -g "pnpm@${PNPM_VERSION}"
  fi

  if ! command -v rustup >/dev/null; then
    step "rustup"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
  fi
  # shellcheck disable=SC1091
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  step "Rust ${RUST_VERSION} + rust-src + wasm32-unknown-emscripten (the build uses -Z build-std)"
  rustup toolchain install "$RUST_VERSION" --profile minimal --component rust-src --target wasm32-unknown-emscripten

  if ! cbindgen --version 2>/dev/null | grep -q "$CBINDGEN_VERSION"; then
    step "cbindgen ${CBINDGEN_VERSION} (Mozilla's toolchain bootstrap is disabled below)"
    cargo +"$RUST_VERSION" install cbindgen --version "$CBINDGEN_VERSION" --locked
  fi
  step "packer dependencies (resources/node_modules)"
  (cd "$RES" && npm install --no-audit --no-fund)
}

clone() {
  if [ ! -d "$REPO/.git" ]; then
    step "clone firefox-wasm -> $REPO"
    mkdir -p "$(dirname "$REPO")"
    git clone "$FIREFOX_WASM_URL" "$REPO"
  fi
  git -C "$REPO" fetch -q origin "$FIREFOX_WASM_REF" 2>/dev/null || true
  git -C "$REPO" checkout -q "$FIREFOX_WASM_REF"
  echo "firefox-wasm at $(git -C "$REPO" rev-parse HEAD)"
}

engine_env() {
  # shellcheck disable=SC1091
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  # Overlay on the project's mozconfig. These change how the build runs, not what it builds:
  #  --disable-bootstrap: don't download Mozilla toolchains from firefox-ci-tc (use the
  #    host clang, apt libclang, cargo-installed cbindgen and system node instead)
  #  --disable-debug-symbols: no DWARF in objects (objdir ~26 GB -> about 4 GB);
  #    build-lib.sh links gecko.wasm with -Wl,--strip-debug anyway
  #  --disable-cargo-incremental: Rust incremental caches add many GB and only help rebuilds
  cat > "$REPO/mozconfig.container" <<'EOF'
. "$topsrcdir/../mozconfig.full.emscripten"
ac_add_options --disable-bootstrap
ac_add_options --disable-debug-symbols
ac_add_options --disable-cargo-incremental
EOF
  export EMSDK="$REPO/emsdk"
  export EM_CONFIG="$REPO/em_config"
  export MOZCONFIG="$REPO/mozconfig.container"
  export MOZBUILD_STATE_PATH="$HOME/.mozbuild"
  export LIBCLANG_PATH="/usr/lib/llvm-${LIBCLANG_VERSION}/lib"
  export RUSTUP_TOOLCHAIN="$RUST_VERSION"
  export MACH_NO_TERMINAL_FOOTER=1
  export PATH="$EMSDK/upstream/emscripten:$EMSDK:$HOME/.cargo/bin:$PATH"
  mkdir -p "$MOZBUILD_STATE_PATH"
  # wasm-ld / wasm-opt recurse deeply on the ~230 MB module.
  ulimit -s unlimited 2>/dev/null || ulimit -s 524288 2>/dev/null || true
}

# The proxyfox.html engine patches (resources/patches): single-thread mode, so the page
# runs Gecko when it cannot share memory with Workers (a file opened from disk).
#   firefox-wasm.patch: cooperative pthread runtime (src/coop-threads.c, lib/coop-threads.js),
#                       wasm-native setjmp/longjmp wrappers (gen-coop-sjlj.py), command-loop wakeup
#   gecko.patch:        pure-wasm xptcall (thunks generated from the XPT data by xptcodegen.py)
apply_patch() {  # $1 = git checkout, $2 = patch
  set -- "$1" "$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
  if git -C "$1" apply --reverse --check "$2" 2>/dev/null; then
    echo "   already applied: $(basename "$2")"
  else
    git -C "$1" apply "$2" || die "$(basename "$2") does not apply to $1 (built for firefox-wasm @ ${FIREFOX_WASM_REF:0:10})"
    echo "   applied: $(basename "$2")"
  fi
}

engine() {
  [ -d "$REPO/.git" ] || clone
  engine_env
  (cd "$REPO" && rustup override set "$RUST_VERSION" >/dev/null)
  step "emsdk 6.0.1 (+ WasmFS WISP/provider patches), Gecko fork checkout, Rust std vendoring"
  make -C "$REPO" emsdk firefox vendor
  step "proxyfox.html engine patches (single-thread mode)"
  apply_patch "$REPO" "$RES/patches/firefox-wasm.patch"
  apply_patch "$REPO/firefox" "$RES/patches/gecko.patch"
  step "make web (Gecko -> libxul -> gecko.{js,wasm,data}; hours)"
  echo "   The first mach pass is expected to end with 'wasm-ld ... failed (received SIGSEGV)' on"
  echo "   libxul.so; upstream's Makefile then relinks libxul (relink-engine-r.sh) and continues."
  make -C "$REPO" web
  for f in gecko.js gecko.wasm gecko.data gecko.data.zst gecko-assets.json; do
    [ -s "$REPO/gecko.js/wasm/$f" ] || die "make web finished but gecko.js/wasm/$f is missing"
  done
  step "make chrome-assets (Firefox front-end + full GRE resources archive)"
  make -C "$REPO" chrome-assets
  ls -la "$REPO/gecko.js/wasm" "$REPO/demo/chrome/public"
}

pack() {
  node_ok || die "Node.js 18+ is required (./build.sh deps installs it)"
  [ -d "$RES/node_modules/esbuild" ] || (cd "$RES" && npm install --no-audit --no-fund)
  step "pack -> $HERE/proxyfox.html"
  node "$RES/pack.mjs" --repo "$REPO" --out "$HERE/proxyfox.html"
}

case "${1:-all}" in
  deps) deps ;;
  clone) clone ;;
  engine) preflight; engine ;;
  pack) pack ;;
  all) preflight; deps; clone; engine; pack ;;
  *) die "usage: $0 [all|deps|clone|engine|pack]" ;;
esac
