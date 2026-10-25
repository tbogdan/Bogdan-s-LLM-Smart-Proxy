"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRetention } = require("../lib/state-retention");

test("FIFO exact write capacity, fixed TTL, immutable reads and stable identity", () => {
  let now = 0;
  const r = createRetention({ maxEntries: 2, ttlMs: 10, now: () => now });
  const s = r.store(); const obj = s.object;
  s.set("a", { nested: { text: "hello" } });
  const retained = s.get("a");
  assert.equal(s.get("a"), retained);
  assert.throws(() => { retained.nested.text = "changed"; }, TypeError);
  s.set("b", 2); s.get("a"); s.set("c", 3);
  assert.deepEqual(Object.keys(obj), ["b", "c"]);
  assert.equal(s.size, 2);
  now = 10;
  assert.equal(s.get("b"), undefined);
  s.clearExpired(); assert.equal(s.size, 0);
  assert.equal(obj, s.object);
});

test("shared UTF8 byte budget rejects oversized values without altering caller results", () => {
  const r = createRetention({ maxBytes: 20 });
  const a = r.store(); const b = r.store();
  a.set("a", "ééé"); b.set("b", "1234567890");
  assert.ok(r.bytes <= 20);
  const result = { text: "x".repeat(100) };
  assert.equal(b.set("large", result), false);
  assert.equal(result.text.length, 100);
  assert.equal(b.get("large"), undefined);
  b.delete("b"); a.delete("a"); assert.equal(r.bytes, 0);
});

test("mutable nested caches cap paths on writes and account payload growth", () => {
  const r = createRetention({ maxEntries: 2, maxPaths: 2, maxBytes: 200 });
  const s = r.store({ mutable: true });
  s.object.session = {};
  const session = s.object.session;
  session.a = { reads: 1 }; session.b = { reads: 2 }; session.c = { reads: 3 };
  assert.deepEqual(Object.keys(session), ["b", "c"]);
  assert.equal(s.object.session, session);
  session.c.text = "x".repeat(300);
  assert.equal(s.get("session"), undefined);
  assert.equal(r.bytes, 0);
});

test("drop Sets cap inner hashes and outer sessions without replacing retained references", () => {
  let now = 0;
  const r = createRetention({ maxEntries: 2, maxPaths: 2, ttlMs: 10, now: () => now });
  const s = r.store({ mutable: true });
  s.object.a = new Set(); const drops = s.object.a;
  drops.add("1").add("2").add("3");
  assert.deepEqual([...drops], ["2", "3"]);
  assert.equal(s.object.a, drops);
  s.object.b = new Set(); s.object.c = new Set();
  assert.deepEqual(Object.keys(s.object), ["b", "c"]);
  now = 10; s.clearExpired(); assert.equal(s.size, 0);
});

test("external aliases cannot grow retained payloads, and nested delete releases bytes", () => {
 const r = createRetention(); const s = r.store({ mutable: true });
 const input = { values: {} }; s.set("a", input); input.values.secret = "untracked";
 assert.equal(s.get("a").values.secret, undefined);
 const value = s.get("a"); value.values.large = "x".repeat(100);
 const before = r.bytes; delete value.values.large; assert.ok(r.bytes < before);
});

test("invalid configuration uses safe defaults and cleanup timer can be stopped", () => {
 const r = createRetention({ maxEntries: -1, ttlMs: NaN, maxBytes: 0, maxPaths: Infinity });
 assert.equal(r.config.maxEntries, 2000); assert.equal(r.config.maxBytes, 67108864);
 const timer = r.start(); assert.equal(timer.hasRef(), false); r.stop(); r.stop();
});

test("mutable array retention preserves newest records and does not expose raw values", () => {
 const r = createRetention({ maxPaths: 2 }); const s = r.store({ mutable: true });
 s.set("audit", []); const audit = s.get("audit");
 audit.push({ n: 1 }); audit.push({ n: 2 }); audit.push({ n: 3 });
 assert.deepEqual(audit.map(x => x.n), [2, 3]);
 const before = r.bytes; audit[1].text = "x".repeat(20); assert.ok(r.bytes > before);
});

test("state owners bound outer drop sessions, file paths and preserve authoritative data", () => {
 const { execFileSync } = require("node:child_process");
 execFileSync(process.execPath, ["-e", `
 const assert = require('node:assert/strict'); const state = require('./lib/state');
 const refs = [state.fileActivity, state.compactionDropCache, state.humanApprovals.pending];
 state.humanApprovals.pending.keep = { status: 'pending' };
 state.humanApprovals.byRequestHash.keep = 'keep'; state.groupBans.keep = true;
 for (const key of ['a','b','c']) state.compactionDropCache[key] = new Set(['1','2','3']);
 assert.deepEqual(Object.keys(state.compactionDropCache), ['b','c']);
 assert.deepEqual([...state.compactionDropCache.c], ['2','3']);
 const c = require('./lib/compaction');
 for (const key of ['a','b','c']) c.trackFileActivity('s',key,'read');
 assert.deepEqual(Object.keys(state.fileActivity.s), ['b','c']);
 const retained = state.fileActivity.s; c.trackFileActivity('s','c','read');
 assert.equal(state.fileActivity.s,retained); assert.equal(retained.c.reads,2);
 state.humanApprovals.audit.push({ event: 'approved' });
 state.retention.clearExpired();
 assert.equal(state.humanApprovals.pending.keep.status,'pending');
 assert.equal(state.humanApprovals.byRequestHash.keep,'keep'); assert.equal(state.groupBans.keep,true);
 assert.equal(refs[0],state.fileActivity); assert.equal(refs[1],state.compactionDropCache); assert.equal(refs[2],state.humanApprovals.pending);
 `], { cwd: require('node:path').join(__dirname,'..'), env: { ...process.env, LLM_PROXY_CACHE_MAX_ENTRIES: '2', LLM_PROXY_CACHE_MAX_PATHS_PER_SESSION: '2' } });
});

test("shared byte pressure evicts across stores and counts multibyte keys exactly", () => {
 const r = createRetention({ maxBytes: 10 }); const a = r.store(); const b = r.store();
 assert.equal(a.set("é", "éé"), true); assert.equal(r.bytes, 6);
 assert.equal(b.set("b", "12345"), true);
 assert.equal(a.get("é"), undefined); assert.equal(b.get("b"), "12345"); assert.equal(r.bytes, 6);
 b.set("b", "x"); assert.equal(r.bytes, 2);
});

test("TTL reads neither refresh nor change frozen payload snapshots", () => {
 let now = 0; const r = createRetention({ ttlMs: 10, now: () => now }); const s = r.store();
 const original = { nested: ["one"] }; s.set("a", original); original.nested.push("two");
 assert.deepEqual(s.get("a").nested, ["one"]);
 now = 9; assert.ok(s.get("a")); now = 10; assert.equal(s.get("a"), undefined); assert.equal(r.bytes, 0);
});

test("audit cache expiry cannot grant an expired approval or remove task security indexes", () => {
 const { execFileSync } = require("node:child_process");
 execFileSync(process.execPath, ["-e", `
 const assert = require('node:assert/strict'); const state = require('./lib/state');
 const approval = require('./lib/human-approval');
 state.humanApprovals.pending.expired = { expires_at_ms: 1, status: 'pending', request_hash: 'expired' };
 state.humanApprovals.byRequestHash.expired = 'expired';
 state.humanApprovals.pending.live = { expires_at_ms: Date.now()+60000, status: 'pending', request_hash: 'live' };
 state.humanApprovals.byRequestHash.live = 'live';
 state.humanApprovals.audit.push({ event: 'approved' });
 state.retention.clearExpired();
 approval.health();
 assert.equal(state.humanApprovals.pending.expired,undefined);
 assert.equal(state.humanApprovals.byRequestHash.expired,undefined);
 assert.equal(state.humanApprovals.pending.live.status,'pending');
 assert.equal(state.humanApprovals.byRequestHash.live,'live');
 `], { cwd: require('node:path').join(__dirname,'..'), env: { ...process.env, DATA_DIR: '/dev/null', LLM_PROXY_CACHE_MAX_BYTES: '1' } });
});

for (const operation of ["assignment", "push", "unshift", "splice", "set-add"]) {
 test(`nested ${operation} caps descendants and charges exact bytes before any child read`, () => {
  const { bytesOf } = require("../lib/state-retention");
  const r = createRetention({ maxPaths: 2 }); const s = r.store({ mutable: true });
  const container = operation === "assignment" ? {} : operation === "set-add" ? new Set() : [];
  s.set("s", container); const retained = s.get("s");
  const input = { nested: { a: 1, b: 2, c: 3 } };
  const expected = { nested: { b: 2, c: 3 } };
  if (operation === "assignment") retained.child = input;
  else if (operation === "set-add") retained.add(input);
  else if (operation === "splice") retained.splice(0, 0, input);
  else retained[operation](input);
  const expectedRoot = operation === "assignment" ? { child: expected } : operation === "set-add" ? new Set([expected]) : [expected];
  assert.equal(r.bytes, 1 + bytesOf(expectedRoot), "admission must trim and account before reading child");
  const before = r.bytes;
  const child = operation === "assignment" ? retained.child : operation === "set-add" ? [...retained][0] : retained[0];
  assert.deepEqual(Object.keys(child.nested), ["b", "c"]);
  assert.equal(r.bytes, before, "reads must not mutate contents or byte accounting");
  child.nested.c = 42; assert.equal(r.bytes, before);
  child.nested.c = "longer string payload"; assert.equal(r.bytes, before - 8 + 21);
  assert.deepEqual(Object.keys(input.nested), ["a", "b", "c"]);
 });
}

test("cleanup interval above Node timer maximum falls back instead of scheduling at 1ms", () => {
 const r = createRetention({ cleanupIntervalMs: 2147483648 });
 assert.equal(r.config.cleanupIntervalMs, 3600000);
 const timer = r.start(); assert.equal(timer.hasRef(), false); r.stop();
 assert.equal(createRetention({ cleanupIntervalMs: 2147483647 }).config.cleanupIntervalMs, 2147483647);
});
