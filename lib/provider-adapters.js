"use strict";

const crypto = require("node:crypto");
const anthropic = require("./anthropic-adapter");
const windsurf = require("./windsurf-cloud");

function protocolOf(provider = {}) {
  return String(provider.protocol || "").trim().toLowerCase();
}

function isOpenAIProtocol(provider = {}) {
  const protocol = protocolOf(provider);
  return protocol === "" || protocol === "openai";
}

function requiresMaxCompletionTokens(provider = {}) {
  const model = String(provider.upstream_model || provider.model || "").toLowerCase();
  const family = String(provider.family || "").toLowerCase();
  return family === "copilot" && /^gpt-5\.([4-9]|\d{2,})(?:$|[-.])/.test(model);
}

function isCodexProvider(provider = {}) {
  const model = String(provider.upstream_model || provider.model || "").toLowerCase();
  const family = String(provider.family || "").toLowerCase();
  const protocol = protocolOf(provider);
  return family === "codex" || protocol === "codex" || model.startsWith("codex/");
}

function normalizeOpenAIChatTokenLimit(provider = {}, body = {}) {
  if (!requiresMaxCompletionTokens(provider)) return body;
  if (body.max_tokens != null && body.max_completion_tokens == null) {
    body.max_completion_tokens = body.max_tokens;
  }
  delete body.max_tokens;
  return body;
}

function normalizeOpenAIUnsupportedParams(provider = {}, body = {}) {
  if (isCodexProvider(provider)) {
    delete body.temperature;
  }
  return body;
}

function hasToolDefinitions(body = {}) {
  return (body.tools?.length || 0) > 0 || (body.functions?.length || 0) > 0;
}

function stripToolControlsWithoutDefinitions(body = {}) {
  if (Array.isArray(body.tools) && body.tools.length === 0) delete body.tools;
  if (Array.isArray(body.functions) && body.functions.length === 0) delete body.functions;
  if (hasToolDefinitions(body)) return body;
  delete body.tool_choice;
  delete body.function_call;
  delete body.parallel_tool_calls;
  return body;
}

function isCopilotProvider(provider = {}) {
  return String(provider.family || "").trim().toLowerCase() === "copilot";
}

function capabilityContract(reqBody = {}) {
  const contract = reqBody?._llmProxyCapabilityContract;
  return contract && typeof contract === "object" ? contract : null;
}

function capabilityFlag(contract = null, path = []) {
  let current = contract;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function requiresStrictToolNames(provider = {}, contract = null) {
  return isCopilotProvider(provider) || capabilityFlag(contract, ["runtime", "toolDialect", "sanitizeToolNames"]) === true;
}

function strictWireToolName(name = "", used = new Map()) {
  const original = String(name || "").trim() || "tool";
  const hash = crypto.createHash("md5").update(original).digest("hex").slice(0, 8);
  const normalized = original.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "tool";
  const makeCandidate = (stem) => (stem.length <= 64 ? stem : `${stem.slice(0, 55)}_${hash}`);
  let candidate = makeCandidate(normalized);
  if (candidate.length > 64) candidate = candidate.slice(0, 64);
  if (!candidate) candidate = `tool_${hash}`;
  if (used.get(candidate) === original) return candidate;
  if (!used.has(candidate)) {
    used.set(candidate, original);
    return candidate;
  }

  let attempt = 0;
  while (attempt < 1000) {
    const suffix = `${hash}${attempt === 0 ? "" : attempt}`;
    const stem = normalized.slice(0, Math.max(1, 64 - suffix.length - 1)) || "tool";
    candidate = `${stem}_${suffix}`.slice(0, 64);
    if (used.get(candidate) === original) return candidate;
    if (!used.has(candidate)) {
      used.set(candidate, original);
      return candidate;
    }
    attempt += 1;
  }

  const fallback = `tool_${crypto.randomBytes(4).toString("hex")}`.slice(0, 64);
  used.set(fallback, original);
  return fallback;
}

function cloneToolCallsWithNames(toolCalls = [], getWireName) {
  return toolCalls.map((toolCall) => {
    const next = { ...toolCall };
    if (toolCall?.function) {
      next.function = { ...toolCall.function };
      if (toolCall.function.name) next.function.name = getWireName(toolCall.function.name);
    }
    return next;
  });
}

function attachToolNameMaps(body, forwardMap, reverseMap) {
  Object.defineProperty(body, "__llmProxyToolNameForwardMap", { value: forwardMap, enumerable: false });
  Object.defineProperty(body, "__llmProxyToolNameReverseMap", { value: reverseMap, enumerable: false });
  return body;
}

function normalizeStrictToolNames(provider = {}, body = {}, contract = null) {
  if (!requiresStrictToolNames(provider, contract)) return body;
  const used = new Map();
  const forward = new Map();
  const reverse = new Map();
  const remember = (original) => {
    const key = String(original || "").trim();
    if (!key) return "";
    if (forward.has(key)) return forward.get(key);
    const wire = strictWireToolName(key, used);
    forward.set(key, wire);
    reverse.set(wire, key);
    return wire;
  };

  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map((tool) => {
      const fn = tool?.function || {};
      return {
        ...tool,
        function: {
          ...fn,
          name: remember(fn.name),
        },
      };
    });
  }
  if (Array.isArray(body.functions)) {
    body.functions = body.functions.map((fn) => ({
      ...fn,
      name: remember(fn.name),
    }));
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => {
      const next = { ...message };
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        next.tool_calls = cloneToolCallsWithNames(message.tool_calls, remember);
      }
      if (message.function_call?.name) {
        next.function_call = { ...message.function_call, name: remember(message.function_call.name) };
      }
      if (message.role === "tool" && message.name) next.name = remember(message.name);
      return next;
    });
  }

  return attachToolNameMaps(body, forward, reverse);
}

function restoreOpenAICompatibleResponse(provider = {}, responseBody = "", requestBody = {}) {
  const contract = capabilityContract(requestBody);
  const reverseMap = requestBody?.__llmProxyToolNameReverseMap;
  if (!requiresStrictToolNames(provider, contract) || !(reverseMap instanceof Map) || reverseMap.size === 0) return responseBody;

  let parsed;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return responseBody;
  }

  let changed = false;
  for (const choice of parsed.choices || []) {
    for (const toolCall of choice?.message?.tool_calls || []) {
      const wireName = toolCall?.function?.name;
      const original = reverseMap.get(wireName);
      if (original && toolCall.function.name !== original) {
        toolCall.function.name = original;
        changed = true;
      }
    }
    const functionCall = choice?.message?.function_call;
    if (functionCall?.name) {
      const original = reverseMap.get(functionCall.name);
      if (original && functionCall.name !== original) {
        functionCall.name = original;
        changed = true;
      }
    }
  }

  return changed ? JSON.stringify(parsed) : responseBody;
}

function hydrateBridgeFieldsFromCapabilityContract(body = {}, contract = null) {
  if (!contract) return body;
  const runtime = contract.runtime || {};
  const metadata = runtime.metadata || {};
  const surface = String(runtime.surface || "").toLowerCase();
  if ((surface === "claude-vscode" || surface === "claude-code-cli") && !body._claudeCodeSessionId && metadata.sessionId) {
    body._claudeCodeSessionId = metadata.sessionId;
  }
  if ((surface === "claude-vscode" || surface === "claude-code-cli") && !body._claudeCodeProfile) {
    const profile = {
      ...(metadata.deviceId ? { deviceId: metadata.deviceId } : {}),
      ...(metadata.accountUuid ? { accountUuid: metadata.accountUuid } : {}),
      ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
    };
    if (Object.keys(profile).length > 0) body._claudeCodeProfile = profile;
  }
  return body;
}

function attachCapabilityContract(body = {}, contract = null) {
  if (!contract) return body;
  Object.defineProperty(body, "__llmProxyCapabilityContract", {
    value: contract,
    enumerable: false,
    configurable: true,
  });
  return body;
}

function stripProxyBridgeFields(body = {}, provider = {}) {
  if (!body || typeof body !== "object") return body;
  delete body._llmProxyCapabilityContract;
  delete body._llmProxyClient;
  delete body._llmProxyRuntimeProfile;
  delete body._llmProxyResponsesToolRegistry;
  delete body._llmProxyRuntimeDebug;
  delete body._llmProxyRuntimeHints;
  delete body._llmProxyTrackedTaskState;
  delete body._llmProxyTaskId;
  delete body._llmProxyOwnRetrieval;
  delete body._llmProxyPreserveToolChoice;
  delete body._llmProxyRole;
  delete body._sessionLastProvider;
  delete body._memoryInjection;
  delete body._inputTokens;
  delete body._estimatedTokens;
  delete body._memoryStats;
  delete body._routeTrace;
  delete body._routeWarnings;
  delete body._llmProxyDifficulty;
  delete body._llmProxyRequiredToolContract;
  delete body._llmProxyOriginalHasToolHistory;
  delete body._llmProxyOriginalLastUserText;
  delete body._hiddenContinuationRetries;
  delete body._hiddenContinueFromAssistantHistory;
  delete body._hiddenContinueTotal;
  delete body._hiddenContinueFromReadLoop;
  delete body._dedupedReadLoop;
  if (!String(provider.protocol || "").trim().toLowerCase().startsWith("anthropic")) {
    delete body._claudeCodeSessionId;
    delete body._claudeCodeMetadata;
    delete body._claudeCodeProfile;
    delete body._claudeCodeRequestShape;
  }
  return body;
}

function prepareOpenAICompatibleRequest(provider = {}, reqBody = {}, stream) {
  const contract = capabilityContract(reqBody);
  const body = hydrateBridgeFieldsFromCapabilityContract(
    { ...reqBody, model: provider.upstream_model || provider.model },
    contract,
  );
  body.stream = stream === true;
  if (!body.stream) delete body.stream_options;
  const prepared = normalizeStrictToolNames(
    provider,
    stripToolControlsWithoutDefinitions(
    normalizeOpenAIUnsupportedParams(provider, normalizeOpenAIChatTokenLimit(provider, body)),
    ),
    contract,
  );
  attachCapabilityContract(prepared, contract);
  return stripProxyBridgeFields(prepared, provider);
}

async function routeAnthropic(provider, reqBody) {
  const contract = capabilityContract(reqBody);
  const bridged = hydrateBridgeFieldsFromCapabilityContract({ ...reqBody }, contract);
  const outbound = stripProxyBridgeFields(bridged, provider);
  const options = {
    sessionId: outbound._claudeCodeSessionId,
    profile: outbound._claudeCodeProfile || {
      ...(process.env.CLAUDE_CODE_DEVICE_ID ? { deviceId: process.env.CLAUDE_CODE_DEVICE_ID } : {}),
      ...(process.env.CLAUDE_CODE_ACCOUNT_UUID ? { accountUuid: process.env.CLAUDE_CODE_ACCOUNT_UUID } : {}),
    }
  };
  const converted = anthropic.toAnthropicRequest(provider, outbound, options);
  const resp = await anthropic.postAnthropic(provider, converted, options);
  if (resp.status < 200 || resp.status >= 300) return resp;

  if (outbound.stream === true && /^text\/event-stream/i.test(String(resp.headers?.["content-type"] || ""))) {
    return {
      status: resp.status,
      headers: { ...resp.headers, "content-type": "text/event-stream" },
      body: anthropic.toOpenAIStream(provider.model, resp.body),
    };
  }

  const data = JSON.parse(resp.body);
  return {
    status: resp.status,
    headers: resp.headers || {},
    body: JSON.stringify(anthropic.toOpenAIResponse(provider.model, data)),
  };
}

async function routeAnthropicStream(provider, reqBody, handlers) {
  const contract = capabilityContract(reqBody);
  const bridged = hydrateBridgeFieldsFromCapabilityContract({ ...reqBody, stream: true }, contract);
  const outbound = stripProxyBridgeFields(bridged, provider);
  const options = {
    sessionId: outbound._claudeCodeSessionId,
    profile: outbound._claudeCodeProfile || {
      ...(process.env.CLAUDE_CODE_DEVICE_ID ? { deviceId: process.env.CLAUDE_CODE_DEVICE_ID } : {}),
      ...(process.env.CLAUDE_CODE_ACCOUNT_UUID ? { accountUuid: process.env.CLAUDE_CODE_ACCOUNT_UUID } : {}),
    }
  };
  const converted = anthropic.toAnthropicRequest(provider, outbound, options);
  const resp = await anthropic.postAnthropic(provider, converted, options);
  if (resp.status < 200 || resp.status >= 300) {
    const error = new Error(`HTTP ${resp.status}: ${resp.body || "Anthropic stream error"}`);
    error.status = resp.status;
    error.headers = resp.headers || {};
    error.body = resp.body || "";
    throw error;
  }
  handlers.onChunk(anthropic.toOpenAIStream(provider.model, resp.body));
}

function windsurfErrorToResponse(error) {
  if (!error || !error.status) return null;
  const body = Buffer.isBuffer(error.body)
    ? error.body.toString("utf8")
    : error.body != null ? String(error.body) : error.message || "";
  return {
    status: error.status,
    headers: error.headers || {},
    body,
  };
}

async function routeWindsurf(provider, reqBody) {
  try {
    const contract = capabilityContract(reqBody);
    const bridged = hydrateBridgeFieldsFromCapabilityContract({ ...reqBody }, contract);
    const output = await windsurf.callWindsurfCloud(provider, stripProxyBridgeFields(bridged, provider));
    return { status: 200, headers: {}, body: JSON.stringify(output) };
  } catch (error) {
    const response = windsurfErrorToResponse(error);
    if (response) return response;
    throw error;
  }
}

function isNativeStreamingProtocol(provider = {}) {
  if(require('./opencode').isOpenCode(provider))return true;
  return ["anthropic", "windsurf"].includes(protocolOf(provider));
}

async function routeNativeStream(provider, reqBody, handlers) {
  if(require('./opencode').isOpenCode(provider))return require('./opencode-transport').route(provider,reqBody,{handlers});
  const protocol = protocolOf(provider);
  if (protocol === "anthropic") return routeAnthropicStream(provider, reqBody, handlers);
  if (protocol === "windsurf") {
    const contract = capabilityContract(reqBody);
    const bridged = hydrateBridgeFieldsFromCapabilityContract({ ...reqBody }, contract);
    return windsurf.streamWindsurfCloud(provider, stripProxyBridgeFields(bridged, provider), handlers);
  }
  throw new Error(`Unsupported native streaming protocol: ${provider.protocol}`);
}

async function routeNonStreaming(provider, reqBody, openAIRoute) {
  if(require('./opencode').isOpenCode(provider))return require('./opencode-transport').route(provider,reqBody);
  const protocol = protocolOf(provider);
  if (isOpenAIProtocol(provider) || protocol === "codex") {
    return openAIRoute(provider, reqBody);
  }
  if (protocol === "anthropic") return routeAnthropic(provider, reqBody);
  if (protocol === "windsurf") return routeWindsurf(provider, reqBody);
  throw new Error(`Unsupported provider protocol: ${provider.protocol}`);
}

module.exports = {
  isOpenAIProtocol,
  isNativeStreamingProtocol,
  normalizeOpenAIChatTokenLimit,
  prepareOpenAICompatibleRequest,
  restoreOpenAICompatibleResponse,
  routeNativeStream,
  routeNonStreaming,
  windsurfErrorToResponse,
};
