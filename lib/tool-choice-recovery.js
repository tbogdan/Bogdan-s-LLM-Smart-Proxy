"use strict";

function shouldRecover(error, body, { headersSent = false } = {}) {
  if (headersSent || !body.tools?.length || !body.tool_choice || body.tool_choice === "auto") return false;
  if (![400, 422].includes(Number(error.status || error.statusCode))) return false;
  let parsed;
  try { parsed = typeof error.body === "string" ? JSON.parse(error.body) : error.body; } catch {}
  const detail = parsed?.error;
  if (!detail || typeof detail !== "object") return false;
  const param = String(detail.param || "");
  const message = String(detail.message || "").slice(0, 2000);
  return /^(tool_choice|tools|function_call|functions)(?:[.\[]|$)/i.test(param) ||
    /(?:tool[_ ]?choice|function[_ ]?call|tool schema|function schema)/i.test(message) ||
    /\btools?\b.{0,80}(?:not supported|unsupported|invalid|not allowed)|(?:unsupported|invalid)\b.{0,80}\btools?\b/i.test(message);
}

function request(body) {
  return { ...body, tool_choice: "auto", stream: false };
}

function validate(response, body) {
  let parsed;
  try { parsed = JSON.parse(response.body); } catch {}
  const choices = parsed?.choices;
  const named = typeof body.tool_choice === "object" ? body.tool_choice.function?.name : undefined;
  const valid = Array.isArray(choices) && choices.length > 0 && choices.every(choice => {
    const calls = choice.message?.tool_calls || [];
    if (body.tool_choice === "none") return calls.length === 0;
    if (body.tool_choice === "required" || named)
      return calls.length > 0 && calls.every(call => call.type === "function" &&
        (!named || call.function?.name === named) &&
        (body.tools || []).some(tool => tool.function?.name === call.function?.name));
    return false;
  });
  if (!valid) throw Object.assign(new Error("Automatic tool recovery did not satisfy the requested tool choice"), {
    status: 422,
    body: JSON.stringify({ error: { code: "unsupported_tool_choice", message: "Automatic tool recovery did not satisfy the requested tool choice" } }),
  });
  return response;
}

module.exports = { shouldRecover, request, validate };
