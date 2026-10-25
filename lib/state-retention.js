"use strict";

const DEFAULTS = Object.freeze({ maxEntries: 2000, ttlMs: 3600000, maxPaths: 256, maxBytes: 67108864, cleanupIntervalMs: 3600000 });
function positive(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
// Payload accounting, including UTF-8 keys, is deliberately not a heap measurement.
function bytesOf(value) {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value === null || value === undefined) return 4;
  if (typeof value !== "object") return 8;
  if (value instanceof Set) return [...value].reduce((n, v) => n + bytesOf(v), 0);
  return Object.entries(value).reduce((n, [k, v]) => n + Buffer.byteLength(k) + bytesOf(v), 0);
}
function copy(value, freeze = false) {
  if (!value || typeof value !== "object") return value;
  if (value instanceof Set) return new Set([...value].map(v => copy(v, freeze)));
  const result = Array.isArray(value) ? [] : Object.create(null);
  for (const [k, v] of Object.entries(value)) Object.defineProperty(result, k, { value: copy(v, freeze), enumerable: true, configurable: true, writable: true });
  return freeze ? Object.freeze(result) : result;
}

function createRetention(options = {}) {
  const env = options.env || process.env;
  const config = {};
  const names = { maxEntries: "MAX_ENTRIES", ttlMs: "TTL_MS", maxPaths: "MAX_PATHS_PER_SESSION", maxBytes: "MAX_BYTES", cleanupIntervalMs: "CLEANUP_INTERVAL_MS" };
  for (const [key, suffix] of Object.entries(names)) config[key] = positive(options[key] ?? env[`LLM_PROXY_${key === "cleanupIntervalMs" ? "" : "CACHE_"}${suffix}`], DEFAULTS[key]);
  // Node coerces larger delays to 1ms; reject overflow rather than hot-loop cleanup.
  if (config.cleanupIntervalMs > 2147483647) config.cleanupIntervalMs = DEFAULTS.cleanupIntervalMs;
  const now = options.now || Date.now;
  const leases = new Map(); const stores = new Set(); let bytes = 0; let timer;
  function release(entry) { if (leases.delete(entry)) bytes -= entry.bytes; }
  function reserve(entry, amount) {
    release(entry);
    if (amount > config.maxBytes) { entry.remove(); return false; }
    while (bytes + amount > config.maxBytes && leases.size) leases.keys().next().value.remove();
    entry.bytes = amount; leases.set(entry, true); bytes += amount; return true;
  }
  function store(settings = {}) {
    const entries = new Map(); const target = Object.create(null);
    const maxEntries = positive(settings.maxEntries, config.maxEntries);
    const ttlMs = positive(settings.ttlMs, config.ttlMs);
    const maxPaths = positive(settings.maxPaths, config.maxPaths);
    function remove(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      release(entry); entries.delete(key); delete target[key]; return true;
    }
    function clearExpired() { const t = now(); for (const [key, entry] of entries) if (t - entry.created >= ttlMs) remove(key); }
    function get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.created >= ttlMs) { remove(key); return undefined; }
      return entry.value;
    }
    function set(key, value) {
      key = String(key);
      // Check before copying potentially large payloads. Oversize is a cache miss.
      const amount = Buffer.byteLength(key) + bytesOf(value);
      remove(key);
      if (amount > config.maxBytes) return false;
      const entry = { created: now(), bytes: 0, remove: () => remove(key) };
      const raw = copy(value, !settings.mutable);
      const proxies = new WeakMap();
      const rawValues = new WeakMap();
      const account = () => { if (entries.get(key) === entry) reserve(entry, Buffer.byteLength(key) + bytesOf(raw)); };
      function wrap(v, depth = 0) {
        if (!v || typeof v !== "object") return v;
        if (proxies.has(v)) return proxies.get(v);
        const capped = !settings.dictionaryDepths || settings.dictionaryDepths.includes(depth);
        const order = new Map(Object.keys(v).map(k => [k, true]));
        function trim() {
          if (v instanceof Set) { while (v.size > maxPaths) v.delete(v.values().next().value); }
          else if (Array.isArray(v)) { if (v.length > maxPaths) v.splice(0, v.length - maxPaths); }
          else if (capped) while (order.size > maxPaths) { const k = order.keys().next().value; order.delete(k); delete v[k]; }
        }
        const proxy = new Proxy(v, {
          get(t, k) {
            if (t instanceof Set) {
              if (k === "add") return value => {
                const child = rawValues.get(value) || copy(value);
                wrap(child, depth + 1); // Normalize descendants before admission/accounting.
                t.add(child); trim(); account(); return proxy;
              };
              if (k === "delete") return value => { const result = t.delete(rawValues.get(value) || value); account(); return result; };
              if (k === "has") return value => t.has(rawValues.get(value) || value);
              if (k === "clear") return () => { t.clear(); account(); };
              if (k === "forEach") return (fn, receiver) => t.forEach(value => { const child = wrap(value, depth + 1); fn.call(receiver, child, child, proxy); });
              if (k === Symbol.iterator || k === "values" || k === "keys") return function* () { for (const child of t) yield wrap(child, depth + 1); };
              if (k === "entries") return function* () { for (const child of t) { const exposed = wrap(child, depth + 1); yield [exposed, exposed]; } };
              const result = Reflect.get(t, k, t); return typeof result === "function" ? result.bind(t) : result;
            }
            if (Array.isArray(t) && ["push", "pop", "shift", "unshift", "splice", "reverse", "sort", "fill", "copyWithin"].includes(k)) {
              return (...args) => {
                // Mutate once before trimming: native push writes index then length.
                // Trimming between those two writes would leave a trailing hole.
                const admitted = args.map(arg => {
                  if (typeof arg === "function") return (a, b) => arg(wrap(a, depth + 1), wrap(b, depth + 1));
                  const child = copy(arg); wrap(child, depth + 1); return child;
                });
                const result = Array.prototype[k].apply(t, admitted);
                trim(); account();
                return result === t ? proxy : wrap(result, depth);
              };
            }
            return wrap(Reflect.get(t, k), depth + 1);
          },
          set(t, k, value) {
            const child = copy(value);
            wrap(child, depth + 1);
            Object.defineProperty(t, k, { value: child, writable: true, enumerable: k !== "length", configurable: k !== "length" });
            if (k !== "length") order.set(k, true);
            trim(); account(); return true;
          },
          deleteProperty(t, k) { delete t[k]; order.delete(k); account(); return true; },
          defineProperty(t, k, descriptor) {
            if (!("value" in descriptor)) throw new TypeError("Cache accessors are unsupported");
            return Reflect.set(proxy, k, descriptor.value);
          },
          getOwnPropertyDescriptor(t, k) {
            const descriptor = Reflect.getOwnPropertyDescriptor(t, k);
            if (descriptor?.configurable && "value" in descriptor) descriptor.value = wrap(descriptor.value, depth + 1);
            return descriptor;
          },
        });
        proxies.set(v, proxy); rawValues.set(proxy, v); trim();
        // Eager normalization runs at admission, including every inserted descendant.
        // Reads find existing proxies and never trim retained collections lazily.
        for (const child of v instanceof Set ? v : Object.values(v)) wrap(child, depth + 1);
        return proxy;
      }
      entry.value = settings.mutable ? wrap(raw) : raw;
      // Fixed insertion TTL / FIFO: reads do not refresh expiry or eviction order.
      entries.set(key, entry); target[key] = entry.value;
      if (!reserve(entry, Buffer.byteLength(key) + bytesOf(raw))) return false;
      while (entries.size > maxEntries) remove(entries.keys().next().value);
      return true;
    }
    const object = new Proxy(target, {
      get: (_, key) => get(key),
      set: (_, key, value) => { set(key, value); return true; },
      deleteProperty: (_, key) => { remove(key); return true; },
      ownKeys: () => { clearExpired(); return Reflect.ownKeys(target); },
      has: (_, key) => get(key) !== undefined,
      getOwnPropertyDescriptor: (_, key) => get(key) === undefined ? undefined : { value: get(key), configurable: true, enumerable: true, writable: true },
      defineProperty: (_, key, descriptor) => { if (!("value" in descriptor)) throw new TypeError("Cache accessors are unsupported"); set(key, descriptor.value); return true; },
    });
    const api = { object, get, set, delete: remove, clearExpired, get size() { clearExpired(); return entries.size; } };
    stores.add(api); return api;
  }
  return {
    config, store, get bytes() { return bytes; },
    clearExpired() { for (const s of stores) s.clearExpired(); },
    start() { if (!timer) { timer = setInterval(() => { for (const s of stores) s.clearExpired(); }, config.cleanupIntervalMs); timer.unref(); } return timer; },
    stop() { clearInterval(timer); timer = undefined; },
  };
}
module.exports = { createRetention, DEFAULTS, bytesOf };
