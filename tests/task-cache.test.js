const test = require("node:test"),
  assert = require("node:assert/strict");
const { prepareTaskCache } = require("../lib/task-cache");
test("cache prefix detector preserves caller instructions and supported explicit settings", () => {
  const body = {
    messages: [
      { role: "system", content: "new instruction" },
      { role: "user", content: "question" },
    ],
    prompt_cache_key: "caller-key",
  };
  const a = prepareTaskCache({
    body,
    allocation: { taskKey: "t", role: "p" },
    provider: { family: "openai" },
  });
  assert.deepEqual(a.body, body);
  const b = prepareTaskCache({
    body: {
      ...body,
      messages: [{ role: "system", content: "changed" }, body.messages[1]],
    },
    allocation: { taskKey: "t", role: "p" },
    provider: { family: "openai" },
  });
  assert.notEqual(a.prefixHash, b.prefixHash);
});

test("cache usage retains normalized gateway cache writes", () => {
  const u = require("../lib/task-cache").cacheUsage({
    prompt_tokens_details: { cached_tokens: 12, cache_creation_tokens: 8 },
  });
  assert.equal(u.readTokens, 12);
  assert.equal(u.writeTokens, 8);
});
