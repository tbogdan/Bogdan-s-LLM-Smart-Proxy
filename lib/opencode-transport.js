"use strict";
const upstreamTransport = require("./http-transport");
const crypto = require("node:crypto");
const anthropic = require("./anthropic-adapter");
const { buildHeaders, nativeRequestCompatible } = require("./opencode");
const context = require("./task-context");
const text = (c) =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c
          .filter((p) => p.type === "text")
          .map((p) => p.text || "")
          .join("\n")
      : c == null
        ? ""
        : JSON.stringify(c);
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    throw Object.assign(new Error("Invalid function-call JSON arguments"), {
      status: 400,
    });
  }
};
const pick = (o, keys) =>
  Object.fromEntries(
    keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]),
  );
function responseParts(content, role) {
  if (typeof content === "string")
    return [
      {
        type: role === "assistant" ? "output_text" : "input_text",
        text: content,
      },
    ];
  return (content || []).map((p) => {
    if (p.type === "text")
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: p.text,
      };
    if (p.type === "image_url")
      return {
        type: "input_image",
        image_url: p.image_url.url,
        ...(p.image_url.detail ? { detail: p.image_url.detail } : {}),
      };
    if (p.type === "file") return { type: "input_file", ...p.file };
    throw Object.assign(
      new Error("Unsupported Responses content part " + p.type),
      { status: 400 },
    );
  });
}
function geminiParts(content) {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  return (content || []).map((p) => {
    if (p.type === "text") return { text: p.text };
    if (p.type === "input_audio")
      return {
        inlineData: {
          mimeType:
            p.input_audio.format === "mp3"
              ? "audio/mpeg"
              : "audio/" + p.input_audio.format,
          data: p.input_audio.data,
        },
      };
    if (p.type === "video_url" || p.type === "audio_url") {
      const value = p[p.type],
        url = typeof value === "string" ? value : value.url;
      const match = url.match(/^data:([^;]+);base64,(.*)$/s);
      return match
        ? { inlineData: { mimeType: match[1], data: match[2] } }
        : {
            fileData: {
              mimeType:
                value.mime_type ||
                (p.type === "video_url" ? "video/mp4" : "audio/mpeg"),
              fileUri: url,
            },
          };
    }
    if (p.type === "image_url") {
      const u = p.image_url.url,
        m = u.match(/^data:([^;]+);base64,(.*)$/s);
      return m
        ? { inlineData: { mimeType: m[1], data: m[2] } }
        : { fileData: { mimeType: "image/jpeg", fileUri: u } };
    }
    if (p.type === "file") {
      const file = p.file || {},
        m = file.file_data?.match(/^data:([^;]+);base64,(.*)$/s);
      if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
      if (file.file_url)
        return {
          fileData: {
            mimeType: file.mime_type || "application/pdf",
            fileUri: file.file_url,
          },
        };
    }
    throw Object.assign(
      new Error("Unsupported Gemini content part " + p.type),
      { status: 400 },
    );
  });
}
function toRequest(provider, body, stream) {
  const model = provider.upstream_model,
    protocol = provider.protocol;
  const tools = body.tools || [];
  if (protocol === "anthropic") {
    const r = anthropic.toAnthropicRequest(
      provider,
      {
        ...body,
        messages: (body.messages || []).map((m) =>
          m.role === "developer" ? { ...m, role: "system" } : m,
        ),
      },
      {
        env: { LLM_PROXY_CLAUDE_CODE_FINGERPRINT: "false" },
      },
    );
    r.stream = stream;
    if (body.tool_choice === "none") r.tool_choice = { type: "none" };
    else if (body.tool_choice === "required") r.tool_choice = { type: "any" };
    else if (body.tool_choice?.function)
      r.tool_choice = { type: "tool", name: body.tool_choice.function.name };
    else if (body.tool_choice === "auto") r.tool_choice = { type: "auto" };
    if (body.thinking) r.thinking = body.thinking;
    return r;
  }
  if (protocol === "responses") {
    const input = [];
    for (const m of body.messages || []) {
      if (m.role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: m.tool_call_id,
          output: text(m.content),
        });
        continue;
      }
      if (
        m.content !== null &&
        m.content !== undefined &&
        (Array.isArray(m.content) ? m.content.length > 0 : m.content !== "")
      )
        input.push({ role: m.role, content: responseParts(m.content, m.role) });
      for (const c of m.tool_calls || [])
        input.push({
          type: "function_call",
          call_id: c.id,
          name: c.function.name,
          arguments: c.function.arguments || "{}",
        });
    }
    const r = {
      model,
      input,
      stream,
      store: false,
      ...pick(body, ["temperature", "top_p", "parallel_tool_calls"]),
    };
    if (body.max_completion_tokens ?? body.max_tokens)
      r.max_output_tokens = body.max_completion_tokens ?? body.max_tokens;
    if (body.reasoning_effort) r.reasoning = { effort: body.reasoning_effort };
    if (tools.length)
      r.tools = tools.map((t) => ({ type: "function", ...t.function }));
    if (body.tool_choice)
      r.tool_choice =
        typeof body.tool_choice === "object"
          ? { type: "function", name: body.tool_choice.function?.name }
          : body.tool_choice;
    if (body.response_format) {
      const f = body.response_format;
      r.text = {
        format:
          f.type === "json_schema"
            ? { type: "json_schema", ...f.json_schema }
            : f,
      };
    }
    return r;
  }
  if (protocol === "gemini") {
    const contents = [],
      system = [],
      names = new Map();
    for (const m of body.messages || []) {
      if (m.role === "system" || m.role === "developer") {
        system.push(...geminiParts(m.content));
        continue;
      }
      if (m.role === "tool") {
        const name = names.get(m.tool_call_id) || m.name;
        if (!name)
          throw Object.assign(
            new Error("Gemini tool result missing matching call"),
            { status: 400 },
          );
        let response;
        try {
          response = JSON.parse(text(m.content));
        } catch {
          response = { result: text(m.content) };
        }
        if (
          !response ||
          typeof response !== "object" ||
          Array.isArray(response)
        )
          response = { result: response };
        contents.push({
          role: "user",
          parts: [{ functionResponse: { name, response } }],
        });
        continue;
      }
      const parts = geminiParts(m.content);
      for (const c of m.tool_calls || []) {
        names.set(c.id, c.function.name);
        const signature = c.extra_content?.google?.thought_signature;
        parts.push({
          functionCall: {
            name: c.function.name,
            args: parse(c.function.arguments || "{}"),
          },
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      }
      if (parts.length)
        contents.push({
          role: m.role === "assistant" ? "model" : "user",
          parts,
        });
    }
    const r = {
      contents,
      generationConfig: { ...pick(body, ["temperature", "top_p"]) },
    };
    if (r.generationConfig.top_p !== undefined) {
      r.generationConfig.topP = r.generationConfig.top_p;
      delete r.generationConfig.top_p;
    }
    if (body.max_tokens ?? body.max_completion_tokens)
      r.generationConfig.maxOutputTokens =
        body.max_tokens ?? body.max_completion_tokens;
    if (system.length) r.systemInstruction = { parts: system };
    if (tools.length)
      r.tools = [
        {
          functionDeclarations: tools.map((t) =>
            pick(t.function, ["name", "description", "parameters"]),
          ),
        },
      ];
    if (body.tool_choice) {
      const choice = body.tool_choice;
      r.toolConfig = {
        functionCallingConfig: {
          mode: choice === "none" ? "NONE" : choice === "auto" ? "AUTO" : "ANY",
          ...(choice?.function
            ? { allowedFunctionNames: [choice.function.name] }
            : {}),
        },
      };
    }
    if (body.response_format?.type === "json_object")
      r.generationConfig.responseMimeType = "application/json";
    if (body.response_format?.type === "json_schema") {
      r.generationConfig.responseMimeType = "application/json";
      r.generationConfig.responseJsonSchema =
        body.response_format.json_schema.schema;
    }
    return r;
  }
  if (protocol !== "openai")
    throw Object.assign(new Error("Unsupported OpenCode API protocol"), {
      status: 400,
    });
  const r = {
    model,
    messages: (body.messages || []).map((m) =>
      pick(m, [
        "role",
        "content",
        "tool_calls",
        "tool_call_id",
        "name",
        "reasoning_content",
      ]),
    ),
    stream,
    ...pick(body, [
      "max_tokens",
      "max_completion_tokens",
      "temperature",
      "top_p",
      "stop",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "response_format",
      "reasoning_effort",
    ]),
  };
  if (
    provider.access_policy === "native_tool_profile" &&
    r.max_tokens !== undefined
  ) {
    r.max_completion_tokens = r.max_completion_tokens ?? r.max_tokens;
    delete r.max_tokens;
  }
  if (stream) r.stream_options = { include_usage: true };
  return r;
}
function usage(protocol, u = {}) {
  const observedInput =
    protocol === "gemini" ? u.promptTokenCount : u.input_tokens;
  const observedOutput =
    protocol === "gemini" ? u.candidatesTokenCount : u.output_tokens;
  if (!Number.isFinite(observedInput) || !Number.isFinite(observedOutput))
    return undefined;
  if (protocol === "gemini") {
    const input = u.promptTokenCount || 0,
      reason = u.thoughtsTokenCount || 0,
      output = (u.candidatesTokenCount || 0) + reason;
    return {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: u.totalTokenCount ?? input + output,
      prompt_tokens_details: { cached_tokens: u.cachedContentTokenCount || 0 },
      completion_tokens_details: { reasoning_tokens: reason },
    };
  }
  if (protocol === "anthropic") {
    const read = u.cache_read_input_tokens || 0,
      write = u.cache_creation_input_tokens || 0,
      input = (u.input_tokens || 0) + read + write,
      output = u.output_tokens || 0;
    return {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
      prompt_tokens_details: {
        cached_tokens: read,
        cache_creation_tokens: write,
      },
    };
  }
  const input = u.input_tokens || 0,
    output = u.output_tokens || 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: u.total_tokens ?? input + output,
    prompt_tokens_details: {
      cached_tokens: u.input_tokens_details?.cached_tokens || 0,
    },
    completion_tokens_details: {
      reasoning_tokens: u.output_tokens_details?.reasoning_tokens || 0,
    },
  };
}
function fromResponse(provider, data) {
  if (provider.protocol === "openai") return { ...data, model: provider.model };
  if (provider.protocol === "anthropic")
    return {
      ...anthropic.toOpenAIResponse(provider.model, data),
      usage: usage("anthropic", data.usage),
    };
  const message = { role: "assistant", content: "" },
    calls = [];
  let finish = "stop";
  if (provider.protocol === "responses") {
    if (data.status === "failed" || data.status === "cancelled" || data.error)
      throw Object.assign(new Error("OpenCode upstream response failed"), {
        status: 502,
      });
    for (const item of data.output || []) {
      if (item.type === "message")
        for (const p of item.content || [])
          if (p.type === "output_text") message.content += p.text;
          else if (p.type === "refusal") message.refusal = p.refusal;
      if (item.type === "function_call")
        calls.push({
          id: item.call_id,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "{}" },
        });
      if (item.type === "reasoning")
        message.reasoning_content = (item.summary || [])
          .map((p) => p.text || "")
          .join("");
    }
    if (data.status === "incomplete") finish = "length";
  } else {
    const candidate = data.candidates?.[0];
    if (!candidate)
      throw Object.assign(new Error("OpenCode Gemini returned no candidate"), {
        status: 502,
      });
    for (const p of candidate.content?.parts || []) {
      if (p.text) {
        if (p.thought)
          message.reasoning_content =
            (message.reasoning_content || "") + p.text;
        else message.content += p.text;
      }
      if (p.functionCall)
        calls.push({
          id:
            p.functionCall.id ||
            "call_" + crypto.randomBytes(8).toString("hex"),
          type: "function",
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args || {}),
          },
          ...(p.thoughtSignature
            ? {
                extra_content: {
                  google: { thought_signature: p.thoughtSignature },
                },
              }
            : {}),
        });
    }
    if (candidate.finishReason === "MAX_TOKENS") finish = "length";
    else if (candidate.finishReason && candidate.finishReason !== "STOP")
      finish = "content_filter";
  }
  if (calls.length) {
    message.tool_calls = calls;
    finish = "tool_calls";
  }
  return {
    id: data.id || "chatcmpl_" + crypto.randomBytes(8).toString("hex"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: provider.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usage(provider.protocol, data.usage || data.usageMetadata),
  };
}
function streamConverter(provider, onChunk) {
  let terminal = false,
    finishSent = false,
    callIndex = 0;
  const calls = new Map();
  let retainedCallBytes = 0;
  const rememberCall = (key,value) => {retainedCallBytes += Buffer.byteLength(JSON.stringify(value))- (calls.has(key)?Buffer.byteLength(JSON.stringify(calls.get(key))):0);calls.set(key,value);};
  let u = {};
  let observedUsage;
  const id = "chatcmpl_" + crypto.randomBytes(8).toString("hex");
  function emit(delta = {}, finish = null, tokens) {
    if (tokens) observedUsage = tokens;
    const c = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: provider.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(tokens ? { usage: tokens } : {}),
    };
    onChunk("data: " + JSON.stringify(c) + "\n\n");
  }
  function event(data) {
    if (data === "[DONE]") {
      terminal = true;
      return;
    }
    let e;
    try {
      e = JSON.parse(data);
    } catch {
      throw Object.assign(new Error("Malformed upstream SSE JSON"), {
        status: 502,
      });
    }
    if (
      e.error ||
      e.type === "error" ||
      e.type === "response.failed" ||
      e.type === "response.cancelled"
    )
      throw Object.assign(new Error("OpenCode provider stream failed"), {
        status: 502,
        body: JSON.stringify(e.error || e.response?.error || {}),
      });
    if (provider.protocol === "openai") {
      if (e.usage) observedUsage = e.usage;
      if (e.choices?.some((c) => c.finish_reason)) terminal = true;
      onChunk(
        "data: " + JSON.stringify({ ...e, model: provider.model }) + "\n\n",
      );
      return;
    }
    if (provider.protocol === "responses") {
      if (e.type === "response.output_text.delta") emit({ content: e.delta });
      if (e.type === "response.reasoning_summary_text.delta")
        emit({ reasoning_content: e.delta });
      if (
        e.type === "response.output_item.added" &&
        e.item?.type === "function_call"
      ) {
        const c = {
          index: callIndex++,
          id: e.item.call_id,
          type: "function",
          function: { name: e.item.name, arguments: e.item.arguments || "" },
        };
        rememberCall(e.item.id, c);
        emit({ tool_calls: [c] });
      }
      if (e.type === "response.function_call_arguments.delta") {
        const c = calls.get(e.item_id);
        if (!c)
          throw Object.assign(
            new Error("Missing streamed function call identity"),
            { status: 502 },
          );
        emit({
          tool_calls: [{ index: c.index, function: { arguments: e.delta } }],
        });
      }
      if (e.type === "response.completed" || e.type === "response.incomplete") {
        terminal = true;
        emit(
          {},
          calls.size
            ? "tool_calls"
            : e.type === "response.incomplete"
              ? "length"
              : "stop",
          usage("responses", e.response?.usage),
        );
        finishSent = true;
      }
      return;
    }
    if (provider.protocol === "anthropic") {
      if (e.type === "message_start") u = { ...e.message?.usage };
      if (
        e.type === "content_block_start" &&
        e.content_block?.type === "tool_use"
      ) {
        const c = {
          index: callIndex++,
          id: e.content_block.id,
          type: "function",
          function: { name: e.content_block.name, arguments: "" },
        };
        rememberCall(e.index, c);
        emit({ tool_calls: [c] });
      }
      if (e.type === "content_block_delta") {
        const d = e.delta || {};
        if (d.type === "text_delta") emit({ content: d.text });
        if (d.type === "thinking_delta")
          emit({ reasoning_content: d.thinking });
        if (d.type === "input_json_delta") {
          const c = calls.get(e.index);
          if (!c)
            throw Object.assign(new Error("Missing Anthropic tool identity"), {
              status: 502,
            });
          emit({
            tool_calls: [
              { index: c.index, function: { arguments: d.partial_json } },
            ],
          });
        }
      }
      if (e.type === "message_delta") {
        u = { ...u, ...e.usage };
        if (e.delta?.stop_reason) {
          emit(
            {},
            e.delta.stop_reason === "tool_use"
              ? "tool_calls"
              : e.delta.stop_reason === "max_tokens"
                ? "length"
                : "stop",
            usage("anthropic", u),
          );
          finishSent = true;
        }
      }
      if (e.type === "message_stop") terminal = true;
      return;
    }
    const c = e.candidates?.[0];
    for (const p of c?.content?.parts || []) {
      if (p.text)
        emit(p.thought ? { reasoning_content: p.text } : { content: p.text });
      if (p.functionCall) {
        const tool = {
          index: callIndex++,
          id:
            p.functionCall.id ||
            "call_" + crypto.randomBytes(8).toString("hex"),
          type: "function",
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args || {}),
          },
          ...(p.thoughtSignature
            ? {
                extra_content: {
                  google: { thought_signature: p.thoughtSignature },
                },
              }
            : {}),
        };
        rememberCall(tool.index, tool);
        emit({ tool_calls: [tool] });
      }
    }
    if (e.usageMetadata) u = e.usageMetadata;
    if (c?.finishReason) {
      terminal = true;
      emit(
        {},
        calls.size
          ? "tool_calls"
          : c.finishReason === "MAX_TOKENS"
            ? "length"
            : c.finishReason === "STOP"
              ? "stop"
              : "content_filter",
        usage("gemini", u),
      );
      finishSent = true;
    }
  }
  return {
    retainedBytes: () => retainedCallBytes,
    event,
    end() {
      if (!terminal)
        throw Object.assign(
          new Error("OpenCode stream ended before terminal event"),
          { status: 502 },
        );
      if (!finishSent && provider.protocol !== "openai")
        emit({}, "stop", usage(provider.protocol, u));
      onChunk("data: [DONE]\n\n");
      return observedUsage
        ? { status: 200, body: JSON.stringify({ usage: observedUsage }) }
        : undefined;
    },
  };
}
async function route(
  provider,
  body,
  { handlers, fetchFn = fetch, signal, timeoutMs = 120000 } = {},
) {
  if (!nativeRequestCompatible(provider, body))
    throw Object.assign(
      new Error(
        "Native free profile requires the caller's real read tool; no paid fallback",
      ),
      { status: 403 },
    );
  if (provider.access_policy === "native_tool_profile" && !handlers) {
    const message = { role: "assistant", content: "" },
      calls = new Map();
    let observedUsage,
      id,
      created,
      finish = "stop";
    await route(provider, body, {
      fetchFn,
      signal,
      timeoutMs,
      handlers: {
        onChunk(chunk) {
          for (const block of String(chunk).split("\n\n")) {
            const raw = block.startsWith("data: ") ? block.slice(6).trim() : "";
            if (!raw || raw === "[DONE]") continue;
            const event = JSON.parse(raw);
            id = event.id || id;
            created = event.created || created;
            if (event.usage) observedUsage = event.usage;
            const choice = event.choices?.[0],
              delta = choice?.delta || {};
            if (delta.content) message.content += delta.content;
            if (delta.reasoning_content)
              message.reasoning_content =
                (message.reasoning_content || "") + delta.reasoning_content;
            if (choice?.finish_reason) finish = choice.finish_reason;
            for (const part of delta.tool_calls || []) {
              const key = part.index ?? 0,
                c = calls.get(key) || {
                  id: part.id,
                  type: "function",
                  function: { name: "", arguments: "" },
                };
              if (part.id) c.id = part.id;
              if (part.function?.name) c.function.name += part.function.name;
              if (part.function?.arguments)
                c.function.arguments += part.function.arguments;
              calls.set(key, c);
            }
          }
        },
      },
    });
    if (calls.size) {
      message.tool_calls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v);
      if (!message.content) message.content = null;
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        created,
        object: "chat.completion",
        model: provider.model,
        choices: [{ index: 0, message, finish_reason: finish }],
        ...(observedUsage ? { usage: observedUsage } : {}),
      }),
    };
  }
  const stream = !!handlers;
  const controller = new AbortController(),
    response = context.current()?.response;
  const disconnect = () => {
    if (!response.writableEnded) controller.abort();
  };
  response?.once?.("close", disconnect);
  const signals = [
    AbortSignal.timeout(timeoutMs),
    controller.signal,
    ...(signal ? [signal] : []),
  ];
  try {
    let url = provider.url;
    if (provider.protocol === "gemini" && stream)
      url =
        url.replace(/:generateContent$/, ":streamGenerateContent") + "?alt=sse";
    const headers = buildHeaders(provider, { body });
    if (stream) headers.Accept = "text/event-stream";
    const fetchOptions = {
      method: "POST",
      headers,
      body: JSON.stringify(toRequest(provider, body, stream)),
      signal: upstreamTransport.currentSignal(AbortSignal.any(signals)),
    };
    const r = await upstreamTransport.trackedFetch(url, fetchOptions, {}, fetchFn);
    const responseHeaders = Object.fromEntries(r.headers);
    if (!r.ok) {
      const {body: raw} = await upstreamTransport.readFetchBody(r, upstreamTransport.config.maxErrorBytes);
      if (!stream)
        return { status: r.status, headers: responseHeaders, body: raw };
      throw Object.assign(new Error("OpenCode provider HTTP " + r.status), {
        status: r.status,
        headers: responseHeaders,
        body: raw,
      });
    }
    if (!stream)
      return {
        status: r.status,
        headers: responseHeaders,
        body: JSON.stringify(fromResponse(provider, JSON.parse((await upstreamTransport.readFetchBody(r)).body))),
      };
    if (!/^text\/event-stream/i.test(r.headers.get("content-type") || ""))
      throw Object.assign(new Error("OpenCode did not return SSE"), {
        status: 502,
      });
    const converter = streamConverter(provider, handlers.onChunk),
      decoder = new TextDecoder();
    let buffer = "";
    const consume = () => {
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) converter.event(data);
      }
    };
    const streamRetention = upstreamTransport.collector();
    for await (const chunk of r.body) {
      streamRetention.retain(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 16 * 1024 * 1024)
        throw Object.assign(new Error("Upstream SSE event too large"), {
          status: 502,
        });
      consume();
      streamRetention.resize(Buffer.byteLength(buffer)+converter.retainedBytes());
      await handlers.waitForDrain?.();
    }
    buffer += decoder.decode();
    consume();
    if (buffer.trim()) {
      buffer += "\n\n";
      consume();
    }
    return converter.end();
  } finally {
    response?.removeListener?.("close", disconnect);
  }
}
module.exports = { toRequest, fromResponse, route: (...args) => args[2]?.handlers ? upstreamTransport.withOwnership(() => upstreamTransport.nativeOperation(() => route(...args))) : upstreamTransport.nativeOperation(() => route(...args)), streamConverter };
