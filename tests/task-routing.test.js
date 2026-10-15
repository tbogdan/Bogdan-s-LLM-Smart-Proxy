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
test("pins survive score changes and restart; failed attempts count to lifetime three-model cap", async () => {
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
  for (let i = 0; i < 3; i++) {
    await router.recordFailure({
      taskKey: identity.key,
      reservationId: i === 0 ? first.reservationId : undefined,
      providerId: candidates[i].name,
      reason: "unavailable",
    });
    if (i < 2)
      await router.acquire({
        identity,
        role: "primary",
        candidates: candidates.slice(i + 1),
        event: "unavailable",
      });
  }
  store.close();
  store = createTaskStore({ dataDir: dir });
  router = createTaskRouter({ store });
  await assert.rejects(
    router.acquire({
      identity,
      candidates: [candidates[3]],
      event: "unavailable",
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

test("route-name reuse cannot change pinned canonical model or reserve a fourth model", async () => {
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
  await assert.rejects(
    router.acquire({
      identity,
      candidates: [changed],
      event: "capability_mismatch",
    }),
    { code: "TASK_MODEL_BUDGET_EXHAUSTED" },
  );
  assert.equal(router.inspect(identity.key).models.length, 3);
  store.close();
});
