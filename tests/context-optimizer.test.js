const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createContextStore } = require("../lib/context-store");
const { createContextOptimizer } = require("../lib/context-optimizer");
test("tool compression is reversible, scoped and stable across replay", () => {
  const store = createContextStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-")),
    maxBytes: 1000000,
  });
  const optimizer = createContextOptimizer({ store });
  const body =
    "INFO repeated\n".repeat(300) + "ERROR preserve this exact failure\n";
  const messages = [
    { role: "system", content: "constraints" },
    { role: "tool", tool_call_id: "r", content: body },
  ];
  const a = optimizer.prepare({
    taskKey: "a",
    role: "primary",
    messages,
    retrievalAvailable: true,
  });
  assert.ok(a.messages[1].content.length < body.length);
  assert.equal(a.messages[0].content, "constraints");
  assert.equal(
    store.get({ taskKey: "a", ref: a.refs[0].ref }).toString(),
    body,
  );
  assert.throws(
    () => store.get({ taskKey: "b", ref: a.refs[0].ref }),
    /not found/,
  );
  assert.deepEqual(
    optimizer.prepare({
      taskKey: "a",
      role: "primary",
      messages,
      retrievalAvailable: true,
    }).messages,
    a.messages,
  );
  assert.deepEqual(
    optimizer.prepare({ taskKey: "a", messages, retrievalAvailable: false })
      .messages,
    messages,
  );
  store.close();
});
test("full-content digests distinguish equal ends and preserve exact-edit and instructions", () => {
  const store = createContextStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hash-")),
  });
  const a = store.put({
      taskKey: "a",
      bytes: "x".repeat(210) + "aaa" + "y".repeat(210),
    }),
    b = store.put({
      taskKey: "a",
      bytes: "x".repeat(210) + "bbb" + "y".repeat(210),
    });
  assert.notEqual(a.sha256, b.sha256);
  const optimizer = createContextOptimizer({ store });
  const messages = [
    { role: "user", content: "important ".repeat(1000) },
    { role: "tool", content: "diff --git a/a b/a\n" + "+code\n".repeat(300) },
  ];
  assert.deepEqual(
    optimizer.prepare({ taskKey: "a", messages, retrievalAvailable: true })
      .messages,
    messages,
  );
  store.close();
});
