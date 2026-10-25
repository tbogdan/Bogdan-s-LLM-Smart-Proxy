const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createTaskStore } = require("../lib/task-store");
const {
  createTaskRouter,
  resolveTaskIdentity,
} = require("../lib/task-routing");
const candidates = ["a", "b", "c", "d"].map((model) => ({
  name: model,
  model: "lab/" + model,
  canonical_model: "lab/" + model,
  key: "fixture",
  caps: ["text", "tools"],
  context: 10000,
}));
const identity = resolveTaskIdentity({
  clientScope: "client-a",
  taskId: "one",
});
test("pins survive score changes and restart; three healthy models fill functional slots", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-"));
  let store = createTaskStore({ dataDir: dir });
  let router = createTaskRouter({ store });
  const first = await router.acquire({
    identity,
    role: "primary",
    candidates,
    event: "start",
  });
  assert.equal(first.providerId, "a");
  const same = await router.acquire({
    identity,
    role: "primary",
    candidates: [...candidates].reverse(),
    event: "continue",
  });
  assert.equal(same.providerId, "a");
  // Three concurrently usable models fill the functional slots.
  for (const candidate of [candidates[1], candidates[2]]) {
    await router.acquire({
      identity,
      role: "helper_" + candidate.name,
      candidates: [candidate],
      event: "specialist",
    });
  }
  store.close();
  store = createTaskStore({ dataDir: dir });
  router = createTaskRouter({ store });
  assert.equal(router.inspect(identity.key).models.length, 3);
  await assert.rejects(
    router.acquire({
      identity,
      role: "extra_helper",
      candidates: [candidates[3]],
      event: "specialist",
    }),
    { code: "TASK_MODEL_BUDGET_EXHAUSTED" },
  );
  store.close();
});
test("scoped identity and final-slot concurrency cannot create a fourth LLM", async () => {
  assert.notEqual(
    identity.key,
    resolveTaskIdentity({ clientScope: "other", taskId: "one" }).key,
  );
  const store = createTaskStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "race-")),
  });
  const r = createTaskRouter({ store });
  await r.acquire({
    identity,
    role: "primary",
    candidates: [candidates[0]],
    event: "start",
  });
  await r.acquire({
    identity,
    role: "review",
    candidates: [candidates[1]],
    event: "independent_review",
  });
  const results = await Promise.allSettled([
    r.acquire({
      identity,
      role: "worker",
      candidates: [candidates[2]],
      event: "specialist",
    }),
    r.acquire({
      identity,
      role: "worker2",
      candidates: [candidates[3]],
      event: "specialist",
    }),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(r.inspect(identity.key).models.length, 3);
  store.close();
});

test("route-name reuse requires explicit mismatch and replaces rather than adds a functional model", async () => {
  const store = createTaskStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "reuse-")),
  });
  const router = createTaskRouter({ store });
  await router.acquire({
    identity,
    candidates: [candidates[0]],
    event: "start",
  });
  for (const i of [1, 2])
    await router.acquire({
      identity,
      role: "helper" + i,
      candidates: [candidates[i]],
      event: "specialist",
    });
  const changed = { ...candidates[3], name: candidates[0].name };
  await assert.rejects(
    router.acquire({ identity, candidates: [changed], event: "continue" }),
    { code: "TASK_PIN_UNAVAILABLE" },
  );
  const replacement = await router.acquire({identity, candidates: [changed], event: "capability_mismatch"});
  assert.equal(replacement.canonicalModel, "lab/d");
  assert.equal(router.inspect(identity.key).modelHistory.length, 4);
  assert.equal(router.inspect(identity.key).models.length, 3);
  store.close();
});

test("failed attempts free the lifetime budget slot instead of burning it", async () => {
  // Regression: a revoked-token / rate-limited / 502-native-stream failover
  // permanently burned one of the three lifetime model slots, so a later
  // healthy provider was locked out with TASK_MODEL_BUDGET_EXHAUSTED.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-evict-"));
  const store = createTaskStore({ dataDir: dir });
  const router = createTaskRouter({ store });
  const fresh = resolveTaskIdentity({ clientScope: "client-b", taskId: "evict-1" });

  const first = await router.acquire({
    identity: fresh,
    role: "primary",
    candidates: [candidates[0]],
    event: "start",
  });
  assert.equal(first.providerId, "a");

  // First failover: the chosen provider failed (rate limit / auth / stream).
  const second = await router.acquire({
    identity: fresh,
    role: "primary",
    candidates: [candidates[1]],
    event: "unavailable",
  });
  assert.equal(second.providerId, "b");
  await router.recordFailure({
    taskKey: fresh.key,
    providerId: "b",
    reason: "unavailable",
  });
  // The slot used by b is released, so a third, healthy attempt can still run
  // instead of dying with TASK_MODEL_BUDGET_EXHAUSTED.
  const third = await router.acquire({
    identity: fresh,
    role: "primary",
    candidates: [candidates[2]],
    event: "unavailable",
  });
  assert.equal(third.providerId, "c");

  const record = router.inspect(fresh.key);
  assert.ok(!record.models.includes("lab/b"), "failed model must be evicted from lifetime budget");
  assert.ok(record.modelHistory.includes("lab/a"));
  assert.ok(!record.models.includes("lab/a"), "unavailable previous pin no longer occupies a functional slot");
  assert.ok(record.models.includes("lab/c"));
  assert.ok(record.failed.includes("b"), "failed provider stays excluded");
  store.close();
});


test("three functional slots allow replacing an unusable pinned model and retain audit history", async () => {
 const store = createTaskStore({dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "functional-slots-"))});
 const router = createTaskRouter({store});
 try {
  for (const [i, role] of ["primary", "review", "worker"].entries()) {
   await router.acquire({identity, role, candidates: [candidates[i]], event: i ? "specialist" : "start"});
  }
  const next = await router.acquire({identity, role: "primary", candidates: [candidates[3]], event: "capability_mismatch"});
  assert.equal(next.providerId, "d");
  const record = router.inspect(identity.key);
  assert.deepEqual(record.models.sort(), ["lab/b", "lab/c", "lab/d"]);
  assert.deepEqual(record.modelHistory.sort(), ["lab/a", "lab/b", "lab/c", "lab/d"]);
  assert.equal(record.retiredModels.at(-1).reason, "capability_mismatch");
 } finally {store.close();}
});

test("assessment helper models do not consume the primary functional budget", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-helper-"));
  const store = createTaskStore({ dataDir: dir });
  const router = createTaskRouter({ store });
  const fresh = resolveTaskIdentity({ clientScope: "client-helper", taskId: "helper-1" });
  try {
    const primary = await router.acquire({ identity: fresh, role: "primary", candidates: [candidates[0]], event: "start" });
    assert.equal(primary.providerId, "a");
    for (const role of ["assessment", "memory"]) {
      for (let i = 1; i <= 3; i += 1) {
        await router.acquire({ identity: fresh, role, candidates: [candidates[i % candidates.length]], event: "specialist" });
      }
    }
    const nextPrimary = await router.acquire({ identity: fresh, role: "primary", candidates: [candidates[1]], event: "specialist" });
    assert.equal(nextPrimary.providerId, "b");
    const record = router.inspect(fresh.key);
    assert.equal(record.models.length, 2, "only primary models consume the functional budget");
    assert.ok(record.models.includes("lab/a"));
    assert.ok(record.models.includes("lab/b"));
  } finally {
    store.close();
  }
});
