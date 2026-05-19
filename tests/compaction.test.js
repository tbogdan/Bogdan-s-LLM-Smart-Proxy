"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const compaction = require("../lib/compaction");
const state = require("../lib/state");

test("recordCompactionDrops and applyCompactionDrops replay dropped old messages per session", () => {
  const sessionId = "test-session-drop-cache";
  delete state.compactionDropCache[sessionId];

  const original = [
    { role: "system", content: "System stays" },
    { role: "user", content: "Please remember this old implementation detail about module alpha and beta." },
    { role: "assistant", content: "Old analysis that compaction decided to drop because it is superseded." },
    { role: "user", content: "Recent request should stay because it survived compaction." },
  ];
  const compacted = [
    original[0],
    { role: "assistant", content: "[CONTEXT COMPACTED]" },
    original[3],
  ];

  compaction.recordCompactionDrops(sessionId, original, compacted);
  const replayed = compaction.applyCompactionDrops(sessionId, [...original]);

  assert.deepEqual(replayed, [original[0], original[3]]);
});

test("detectGarbledText ignores compaction artifacts but catches repeated sentence loops", () => {
  const compacted = "[CONTEXT COMPACTED - 20 messages removed]\nTool output lines] Search: 40 results]";
  const loop = Array.from({ length: 8 }, () => "We need to continue with the implementation carefully.").join(" ");

  assert.equal(compaction.detectGarbledText(compacted), false);
  assert.equal(compaction.detectGarbledText(loop), true);
});
