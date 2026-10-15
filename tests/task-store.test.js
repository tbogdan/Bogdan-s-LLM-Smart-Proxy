const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTaskStore } = require("../lib/task-store");

test("crashed writer in different PID namespace can recover after lease expires", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-lock-"));
  const lock = path.join(dir, ".writer-lock");
  fs.writeFileSync(
    lock,
    JSON.stringify({
      pid: 1,
      namespace: "old-container",
      token: "old",
      start: "old",
    }),
  );
  const past = new Date(Date.now() - 10000);
  fs.utimesSync(lock, past, past);
  const store = createTaskStore({ dataDir: dir });
  assert.throws(() => createTaskStore({ dataDir: dir }), {
    code: "STATE_WRITER_CONFLICT",
  });
  store.updateSync("task", () => ({ record: { models: ["one"] } }));
  store.close();
  const next = createTaskStore({ dataDir: dir });
  assert.deepEqual(next.get("task").models, ["one"]);
  next.close();
});

test("writer which loses its lock cannot mutate state or remove new owner lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-owner-"));
  const store = createTaskStore({ dataDir: dir });
  const lock = path.join(dir, ".writer-lock");
  fs.unlinkSync(lock);
  fs.writeFileSync(lock, JSON.stringify({ token: "new-owner" }));
  assert.throws(() => store.updateSync("task", () => ({ record: {} })), {
    code: "STATE_WRITER_CONFLICT",
  });
  store.close();
  assert.equal(JSON.parse(fs.readFileSync(lock)).token, "new-owner");
});
