// Cooperative single-agent pthreads for the emscripten glue (gecko.js).
//
// A page opened from a file (or served without COOP/COEP) is not cross-origin
// isolated, so it may create a shared WebAssembly.Memory but never postMessage it
// to a Worker. Instead of Workers, every pthread runs on the page thread here:
// each "worker" is a fresh evaluation of the same glue (in a scope that looks like
// a worker global) whose own instance of the engine module imports the same
// memory, passed by reference. Threads take turns: a blocking wait in the engine
// (src/coop-threads.c) suspends through JSPI into wait() below and resumes when
// another thread or the page wakes that address.

const SLICE_MS = 12;

export function createCoop({ glueSource, cores = 2, poolSize = 6, log = console.error, debug = false }) {
  const SAB = new WebAssembly.Memory({ initial: 0, maximum: 1, shared: true }).buffer.constructor;
  if (typeof globalThis.SharedArrayBuffer === 'undefined') {
    Object.defineProperty(globalThis, 'SharedArrayBuffer', { value: SAB, configurable: true, writable: true });
  }

  // ---- scheduler ----------------------------------------------------------
  const waiters = new Map();
  let memory = null;
  let i32 = null;
  const view = () => {
    if (!i32 || i32.buffer !== memory.buffer) i32 = new Int32Array(memory.buffer);
    return i32;
  };

  const channel = new MessageChannel();
  let turnPending = false;
  let turnStart = 0;
  let deferred = [];
  const startTurn = () => {
    turnPending = true;
    turnStart = performance.now();
    channel.port2.postMessage(0);
  };
  channel.port1.onmessage = () => {
    turnPending = false;
    if (!deferred.length) return;
    const run = deferred;
    deferred = [];
    startTurn();
    for (const f of run) f();
  };
  const defer = (f) => {
    deferred.push(f);
    if (!turnPending) startTurn();
  };
  let lastSwitch = performance.now();
  const resume = (f) => {
    if (!turnPending) startTurn();
    if (performance.now() - turnStart < SLICE_MS) {
      lastSwitch = performance.now();
      f();
    } else deferred.push(() => { lastSwitch = performance.now(); f(); });
  };

  const stats = { waits: 0, wakes: 0, yields: 0, threads: 0, longRuns: 0, maxRunMs: 0, timeouts: {} };
  // Time since the last resume: how long the thread now suspending ran on its own.
  const stackNow = () => {
    const old = Error.stackTraceLimit;
    Error.stackTraceLimit = 200;
    const st = String(new Error().stack);
    Error.stackTraceLimit = old;
    return st;
  };
  let clockCalls = 0;
  const clockCall = debug ? () => {
    if (++clockCalls === 300000) {
      log('[coop] 300000 clock reads without a thread switch (a thread polls time instead of waiting):\n' +
        stackNow().split('\n').slice(2, 80).join('\n'));
    }
  } : () => {};
  const noteSwitch = (what) => {
    clockCalls = 0;
    const now = performance.now();
    const ran = now - lastSwitch;
    lastSwitch = now;
    if (ran > stats.maxRunMs) stats.maxRunMs = Math.round(ran);
    if (ran > 250) {
      stats.longRuns++;
      if (debug) log(`[coop] a thread ran ${ran.toFixed(0)} ms before this ${what}:\n` + stackNow().split('\n').slice(2, 40).join('\n'));
    }
  };
  if (debug) {
    let last = { ...stats };
    setInterval(() => {
      log(`[coop] heartbeat waits +${stats.waits - last.waits} wakes +${stats.wakes - last.wakes} yields +${stats.yields - last.yields} ` +
        `threads ${stats.threads} parked ${coop.parked} maxRunMs ${stats.maxRunMs}`);
      last = { ...stats };
    }, 5000);
  }

  function wait(addr, val, maxWaitMs) {
    if (Atomics.load(view(), addr >>> 2) !== val) return 1;
    stats.waits++;
    noteSwitch('wait');
    return new Promise((resolve) => {
      const w = { resolve, timer: 0 };
      let list = waiters.get(addr);
      if (!list) waiters.set(addr, (list = []));
      list.push(w);
      if (maxWaitMs !== Infinity) {
        const ms = maxWaitMs > 0 ? maxWaitMs : 0;
        w.timer = setTimeout(() => {
          w.timer = 0;
          const l = waiters.get(addr);
          const i = l ? l.indexOf(w) : -1;
          if (i < 0) return;
          l.splice(i, 1);
          if (!l.length) waiters.delete(addr);
          if (debug) {
            const k = ms < 1 ? '<1' : ms < 10 ? Math.round(ms) : ms < 100 ? Math.round(ms / 10) * 10 : Math.round(ms / 100) * 100;
            stats.timeouts[k] = (stats.timeouts[k] || 0) + 1;
          }
          resume(() => resolve(2));
        }, ms);
      }
    });
  }

  function wake(addr, count) {
    const list = waiters.get(addr);
    if (!list) return 0;
    let n = 0;
    while (list.length && n < count) {
      const w = list.shift();
      if (w.timer) clearTimeout(w.timer);
      resume(() => w.resolve(0));
      n++;
    }
    if (!list.length) waiters.delete(addr);
    stats.wakes += n;
    return n;
  }

  function yieldNow() {
    stats.yields++;
    noteSwitch('yield');
    return new Promise((resolve) => defer(resolve));
  }

  function deadlock(addr, val, ms, thread) {
    const msg = `[coop] thread ${thread || 'main'} would block forever on 0x${addr.toString(16)} (value ${val}) ` +
      'from a context that cannot suspend';
    log(msg + '\n' + new Error().stack);
    throw new Error(msg);
  }

  // Page-side notifies (index.ts command mailbox, host decoders) must also wake
  // threads parked here: none of them is in a real Atomics.wait.
  const realNotify = Atomics.notify;
  Atomics.notify = function notify(ta, index, count) {
    let n = realNotify.call(Atomics, ta, index, count);
    if (memory && ta && ta.buffer instanceof SAB) {
      n += wake(ta.byteOffset + index * ta.BYTES_PER_ELEMENT, count === undefined ? Infinity : count);
    }
    return n;
  };

  // ---- JS <-> wasm call depth (see lib/coop-threads.js) --------------------
  function wrapFunction(f, ctx) {
    const w = function () {
      ctx.depth++;
      try {
        return f.apply(this, arguments);
      } finally {
        ctx.depth--;
      }
    };
    w.coopRaw = f;
    return w;
  }
  function wrapExports(exports, ctx) {
    const out = {};
    for (const [k, v] of Object.entries(exports)) out[k] = typeof v === 'function' ? wrapFunction(v, ctx) : v;
    return out;
  }

  // ---- proxied JS library calls run directly on the main glue --------------
  let mainReceive = null;
  function callOnMain(funcIndex, emAsmAddr, callingThread, proxyMode, args) {
    if (!mainReceive) throw new Error('[coop] main thread glue is not ready for proxied calls');
    return mainReceive(funcIndex, emAsmAddr, callingThread, args);
  }

  // ---- in-page Workers ------------------------------------------------------
  const tasks = [];
  const taskChannel = new MessageChannel();
  let taskPosted = false;
  taskChannel.port1.onmessage = () => {
    taskPosted = false;
    const batch = tasks.splice(0, tasks.length);
    for (const t of batch) t();
  };
  const post = (fn) => {
    tasks.push(fn);
    if (!taskPosted) {
      taskPosted = true;
      taskChannel.port2.postMessage(0);
    }
  };
  const fire = (listeners, handler, ev, self) => {
    if (handler) handler.call(self, ev);
    for (const l of listeners) l.call(self, ev);
  };

  let glueFn = null;
  const compileGlue = () => glueFn ??= new Function(
    'self', 'globalThis', 'window', 'document', 'name', 'location', 'postMessage', 'close',
    'importScripts', 'addEventListener', 'removeEventListener', 'WorkerGlobalScope', 'onmessage',
    glueSource + '\n//# sourceURL=gecko-pthread.js');

  const bound = new Map();
  const forwardGlobal = (k) => {
    if (typeof k !== 'string' || (k.startsWith('__') && k !== '__geckoCoop') || k.startsWith('gecko')) return undefined;
    const v = globalThis[k];
    if (typeof v !== 'function' || /^[A-Z]/.test(k)) return v;
    let b = bound.get(k);
    if (!b) bound.set(k, (b = v.bind(globalThis)));
    return b;
  };

  class CoopWorker {
    constructor(url, options = {}) {
      this.onmessage = null;
      this.onerror = null;
      this.listeners = { message: [], error: [] };
      this.dead = false;
      const worker = this;
      const inner = { listeners: { message: [] }, onmessage: null };
      this.inner = inner;
      const workerPost = (data) => post(() => {
        if (worker.dead) return;
        fire(worker.listeners.message, worker.onmessage, { data, target: worker }, worker);
      });
      const target = {
        name: options.name || '',
        location: { href: url, toString: () => url },
        WorkerGlobalScope: function WorkerGlobalScope() {},
        window: undefined,
        document: undefined,
        importScripts: undefined,
        postMessage: workerPost,
        close: () => { worker.dead = true; },
        addEventListener: (t, f) => { if (t === 'message') inner.listeners.message.push(f); },
        removeEventListener: (t, f) => {
          const l = inner.listeners.message;
          const i = l.indexOf(f);
          if (t === 'message' && i >= 0) l.splice(i, 1);
        },
      };
      const scope = new Proxy(target, {
        get: (t, k) => (k === 'onmessage' ? inner.onmessage : k in t ? t[k] : forwardGlobal(k)),
        set: (t, k, v) => {
          if (k === 'onmessage') inner.onmessage = v;
          else t[k] = v;
          return true;
        },
        has: (t, k) => k in t || k in globalThis,
      });
      this.scope = scope;
      stats.threads++;
      try {
        compileGlue().call(scope, scope, scope, undefined, undefined, target.name, target.location,
          workerPost, target.close, undefined, target.addEventListener, target.removeEventListener,
          target.WorkerGlobalScope, undefined);
      } catch (e) {
        log(`[coop] ${target.name}: glue failed to start: ${e && e.stack || e}`);
        post(() => fire(worker.listeners.error, worker.onerror, { message: String(e), error: e }, worker));
      }
    }

    postMessage(data) {
      const inner = this.inner;
      const scope = this.scope;
      post(() => {
        if (this.dead) return;
        try {
          fire(inner.listeners.message, inner.onmessage, { data, target: scope }, scope);
        } catch (e) {
          log(`[coop] ${this.scope.name}: ${e && e.stack || e}`);
          fire(this.listeners.error, this.onerror, { message: String(e && e.message || e), error: e, filename: 'gecko-pthread.js', lineno: 0 }, this);
        }
      });
    }

    terminate() { this.dead = true; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    removeEventListener(t, f) {
      const l = this.listeners[t] || [];
      const i = l.indexOf(f);
      if (i >= 0) l.splice(i, 1);
    }
    unref() {}
    ref() {}
  }

  const coop = {
    active: true,
    cores,
    poolSize,
    stats,
    Worker: CoopWorker,
    wait,
    wake,
    yieldNow,
    deadlock,
    clockCall,
    wrapExports,
    wrapFunction,
    callOnMain,
    setMemory(m) { if (!memory) memory = m; },
    set mainReceive(f) { mainReceive = f; },
    get mainReceive() { return mainReceive; },
    get parked() {
      let n = 0;
      for (const l of waiters.values()) n += l.length;
      return n;
    },
  };
  globalThis.__geckoCoop = coop;
  return coop;
}
