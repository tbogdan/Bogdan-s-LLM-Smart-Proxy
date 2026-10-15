"use strict";
function compactData(text) {
  if (
    text.length < 2000 ||
    /diff --git|@@ |<thinking|signature|```|^On branch /m.test(text)
  )
    return text;
  const lines = text.split("\n");
  if (lines.length > 20) {
    const out = [];
    let prev,
      count = 0;
    function flush() {
      if (prev !== undefined) {
        out.push(prev);
        if (count > 1) out.push("[previous line repeated " + count + " times]");
      }
    }
    for (const l of lines) {
      if (l === prev) count++;
      else {
        flush();
        prev = l;
        count = 1;
      }
    }
    flush();
    const s = out.join("\n");
    if (s.length < text.length * 0.8) return s;
  }
  try {
    const parsed = JSON.parse(text);
    const compact = JSON.stringify(parsed);
    if (compact.length < text.length * 0.8) return compact;
  } catch {}
  return text;
}
function createContextOptimizer({ store, config = {} } = {}) {
  function prepare({
    taskKey,
    role = "primary",
    messages = [],
    retrievalAvailable = false,
  } = {}) {
    const refs = [];
    let before = 0,
      after = 0;
    const output = messages.map((m) => {
      if (
        !retrievalAvailable ||
        m.role !== "tool" ||
        typeof m.content !== "string" ||
        m.name === "proxy_retrieve_original" ||
        m._proxyOriginalRetrieved
      )
        return m;
      const text = m.content;
      before += text.length;
      let compressed = compactData(text);
      if (compressed !== text) {
        try {
          const original = store.put({
            taskKey,
            role,
            bytes: text,
            strategyVersion: "deterministic-v1",
          });
          const saved = store.representation?.({ taskKey, ref: original.ref });
          compressed =
            saved ||
            compressed +
              "\n[Original " +
              original.ref +
              "; recover exact content with proxy_retrieve_original]";
          if (!saved)
            store.representation?.({
              taskKey,
              ref: original.ref,
              text: compressed,
            });
          if (compressed.length >= text.length) return m;
          refs.push(original);
        } catch {
          return m;
        }
      }
      after += compressed.length;
      return compressed === text ? m : { ...m, content: compressed };
    });
    return {
      messages: output,
      refs,
      diagnostics: { beforeChars: before, afterChars: after, estimated: true },
      strategyVersion: "deterministic-v1",
    };
  }
  return { prepare };
}
module.exports = { createContextOptimizer, compactData };
