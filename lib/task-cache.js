"use strict";
const { digest } = require("./task-store");
function prepareTaskCache({ body, allocation, provider }) {
  const prefix = {
    messages: (body.messages || []).filter((m) =>
      ["system", "developer"].includes(m.role),
    ),
    tools: body.tools || body.functions || [],
    effort: body.reasoning_effort || body.reasoning?.effort || null,
  };
  const copy = { ...body };
  if (
    provider.supports_prompt_cache_key === true &&
    copy.prompt_cache_key === undefined
  )
    copy.prompt_cache_key = digest(
      JSON.stringify([
        allocation.taskKey,
        allocation.role,
        allocation.providerId,
        allocation.accountRef,
      ]),
    );
  return {
    body: copy,
    prefixHash: digest(JSON.stringify(prefix)),
    cacheKey: copy.prompt_cache_key || null,
  };
}
function cacheUsage(u = {}) {
  return {
    readTokens:
      u.prompt_tokens_details?.cached_tokens ??
      u.input_tokens_details?.cached_tokens ??
      u.cache_read_input_tokens ??
      null,
    writeTokens: u.cache_creation_input_tokens ?? null,
    source: "upstream",
  };
}
module.exports = { prepareTaskCache, cacheUsage };
