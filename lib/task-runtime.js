"use strict";
const path = require("node:path"),
  crypto = require("node:crypto");
const context = require("./task-context");
const { createTaskStore, digest } = require("./task-store");
const {
  createTaskRouter,
  resolveTaskIdentity,
  canonicalModel,
} = require("./task-routing");
const { createAccountAvailabilityStore } = require("./account-availability");
const { classifyUpstreamFailure } = require("./upstream-failure");
const { prepareTaskCache } = require("./task-cache");
const { createContextStore } = require("./context-store");
const { createContextOptimizer } = require("./context-optimizer");
const RETRIEVAL = "proxy_retrieve_original";
const RETRIEVAL_TOOL = {
  type: "function",
  function: {
    name: RETRIEVAL,
    description:
      "Recover exact original tool output from this task. Request a byte range when possible.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string" },
        start: { type: "integer", minimum: 0 },
        end: { type: "integer", minimum: 0 },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
};
function createTaskRuntime({
  dataDir,
  getProviders = () => [],
  now = Date.now,
  compression = true,
} = {}) {
  let store, router, accounts, originals, optimizer;
  let eligibility = () => true;
  const secret = crypto.randomBytes(32);
  const stats = {
    requests: 0,
    dispatches: 0,
    fallbacks: 0,
    retrievals: 0,
    compressedChars: 0,
  };
  function services() {
    if (!store) {
      try {
        store = createTaskStore({ dataDir: path.join(dataDir, "tasks") });
        router = createTaskRouter({ store, now });
        accounts = createAccountAvailabilityStore({
          dataDir: path.join(dataDir, "accounts"),
          now,
        });
        originals = createContextStore({
          dataDir: path.join(dataDir, "originals"),
        });
        optimizer = createContextOptimizer({ store: originals });
      } catch (error) {
        for (const service of [originals, accounts, store])
          try {
            service?.close();
          } catch {}
        store = router = accounts = originals = optimizer = undefined;
        throw error;
      }
    }
    return { store, router, accounts };
  }
  function signedHeaders(role) {
    const c = context.current();
    if (!c) return {};
    const value = Buffer.from(
      JSON.stringify({
        scope: c.scope,
        taskId: c.identity.taskId,
        key: c.identity.key,
        role: role || c.role,
        time: now(),
      }),
    ).toString("base64url");
    return {
      "x-llm-proxy-internal-context":
        value +
        "." +
        crypto.createHmac("sha256", secret).update(value).digest("hex"),
    };
  }
  function inherited(headers) {
    const raw = headers["x-llm-proxy-internal-context"];
    if (typeof raw !== "string" || raw.length > 4096) return null;
    const [v, s] = raw.split(".");
    const expected = crypto
      .createHmac("sha256", secret)
      .update(v || "")
      .digest("hex");
    if (
      !s ||
      s.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))
    )
      return null;
    try {
      const data = JSON.parse(Buffer.from(v, "base64url"));
      return Math.abs(now() - data.time) < 3600000 ? data : null;
    } catch {
      return null;
    }
  }
  async function handle(body, res, options = {}, next) {
    if (context.current()) return next(body);
    services();
    const headers = options.headers || {},
      parent = inherited(headers);
    const metadata = body.metadata || {};
    const requestedProfile = metadata.llm_proxy || {};
    const taskText = JSON.stringify(
      (body.messages || [])
        .filter((m) => m.role === "user")
        .map((m) => m.content),
    );
    const risk =
      requestedProfile.risk === "critical" ||
      /security|production incident|destructive|before release/i.test(taskText)
        ? "critical"
        : null;
    const taskType = [
      "FEATURE",
      "BUG_FIX",
      "REVIEW",
      "INVESTIGATION",
      "RESEARCH",
    ].includes(requestedProfile.task_type)
      ? requestedProfile.task_type
      : /review|audit/i.test(taskText)
        ? "REVIEW"
        : /bug|fix|failure|defect/i.test(taskText)
          ? "BUG_FIX"
          : "FEATURE";
    const scope =
      parent?.scope ||
      digest(
        JSON.stringify([
          headers.authorization || "",
          headers["x-llm-proxy-client-id"] ||
            headers["user-agent"] ||
            metadata.client_id ||
            "local",
        ]),
      );
    const first = (body.messages || []).find((m) => m.role === "user");
    const anchor = first ? digest(JSON.stringify(first.content)) : undefined;
    const identity = resolveTaskIdentity({
      clientScope: scope,
      taskId:
        parent?.taskId ||
        headers["x-llm-proxy-task-id"] ||
        metadata.task_id ||
        body._llmProxyTaskId,
      conversationId:
        headers["x-llm-proxy-conversation-id"] ||
        metadata.conversation_id ||
        body.conversation_id,
      conversationAnchor: anchor,
    });
    if (parent) identity.key = parent.key;
    body._llmProxyTaskId = identity.taskId;
    res?.setHeader?.("X-LLM-Proxy-Task-ID", identity.taskId);
    res?.setHeader?.("X-LLM-Proxy-Task-Identity", identity.confidence);
    stats.requests++;
    return context.run(
      {
        identity,
        freeOnly: context.current()?.freeOnly || require("./opencode").requestedFreeOnly(body.model, getProviders()),
        taskProfile: { task_type: taskType, risk },
        sourceRevision:
          typeof requestedProfile.source_revision === "string"
            ? requestedProfile.source_revision.slice(0, 128)
            : null,
        response: res,
        scope,
        runtime: api,
        accounts,
        role: parent?.role || "primary",
        forcedRole: parent?.role,
        candidates: new Map(),
        retrievalAvailable: false,
        retrievalCalls: 0,
        optimizerPreference: headers["x-llm-proxy-optimize"] !== "off",
      },
      () => {
        const forwarded = { ...body };
        if (forwarded.metadata && typeof forwarded.metadata === "object") {
          forwarded.metadata = { ...forwarded.metadata };
          for (const field of [
            "task_id",
            "conversation_id",
            "client_id",
            "llm_proxy",
          ])
            delete forwarded.metadata[field];
        }
        return next(forwarded);
      },
    );
  }
  function roleFor(body) {
    return (
      context.current()?.forcedRole ||
      body._llmProxyRole ||
      (body.model === "auto-memory"
        ? "memory"
        : body.model === "auto-assess"
          ? "assessment"
          : body._llmProxyClient === "codex_virtual_subagent"
            ? "worker"
            : "primary")
    );
  }
  function compatible(p, body) {
    return (
      p &&
      eligibility(p, body) &&
      (!context.current()?.freeOnly || p.billing_class === "free_limited") &&
      require("./opencode").nativeRequestCompatible(p, body) &&
      p.key &&
      p.alive !== false &&
      (!(body.tools?.length || body.functions?.length) ||
        (p.caps || []).includes("tools")) &&
      (!body._inputTokens ||
        !p.context ||
        body._inputTokens < Number(p.context))
    );
  }
  function orderCandidates(list, body) {
    const c = context.current();
    if (!c) return list;
    services();
    const role = roleFor(body),
      pin = router.inspect(c.identity.key)?.roles[role];
    const active = list.filter(
      (p) => compatible(p, body) && accounts.isEligible(p),
    );
    const pinned =
      pin &&
      getProviders().find(
        (p) =>
          p.name === pin.providerId &&
          compatible(p, body) &&
          accounts.isEligible(p),
      );
    const ordered = pinned
      ? [pinned, ...active.filter((p) => p.name !== pinned.name)]
      : pin
        ? [
            ...active.filter((p) => canonicalModel(p) === pin.canonicalModel),
            ...active.filter((p) => canonicalModel(p) !== pin.canonicalModel),
          ]
        : active;
    c.candidates.set(role, ordered);
    return ordered;
  }
  async function beforeDispatch(proposed, body) {
    const c = context.current();
    if (!c) return proposed;
    services();
    const role = roleFor(body),
      record = router.inspect(c.identity.key),
      pin = record?.roles[role];
    const failed = record?.failed || [];
    const all = getProviders();
    restoreHiddenCalls(c, body);
    const pinned = pin && all.find((p) => p.name === pin.providerId);
    let event = pin ? "continue" : "start";
    let candidates;
    const freeOnly = c.freeOnly;
    if (
      pin &&
      pinned &&
      canonicalModel(pinned) === pin.canonicalModel &&
      (pinned.upstream_model || pinned.model) === pin.upstreamModel &&
      compatible(pinned, body) &&
      accounts.isEligible(pinned) &&
      !failed.includes(pinned.name)
    )
      candidates = [pinned];
    else {
      event = pin
        ? failed.includes(pin.providerId) ||
          !pinned ||
          canonicalModel(pinned) !== pin.canonicalModel ||
          (pinned.upstream_model || pinned.model) !== pin.upstreamModel ||
          !accounts.isEligible(pinned)
          ? "unavailable"
          : "capability_mismatch"
        : role === "primary"
          ? "start"
          : "specialist";
      candidates = c.candidates.get(role) || [proposed];
      const extra = all
        .filter((p) => !candidates.some((x) => x.name === p.name))
        .sort(
          (a, b) =>
            Math.abs((a.tier || 2) - (pinned?.tier || proposed.tier || 2)) -
            Math.abs((b.tier || 2) - (pinned?.tier || proposed.tier || 2)),
        );
      candidates = [...candidates, ...extra];
      if (pin) {
        const equivalent = all.filter(
          (p) => canonicalModel(p) === pin.canonicalModel,
        );
        candidates = [
          ...equivalent,
          ...candidates.filter(
            (p) => !equivalent.some((e) => e.name === p.name),
          ),
        ];
      } else if (!String(body.model || "auto").startsWith("auto")) {
        // A new task can start after the requested route has already become
        // unavailable. Preserve its model preference even before a pin exists.
        const requestedCanonical = canonicalModel(proposed);
        candidates = [
          ...candidates.filter(p => canonicalModel(p) === requestedCanonical),
          ...candidates.filter(p => canonicalModel(p) !== requestedCanonical),
        ];
      }
      candidates = candidates.filter(
        (p) => compatible(p, body) && accounts.isEligible(p),
      );
      if (pin)
        candidates = [
          ...candidates.filter((p) => canonicalModel(p) === pin.canonicalModel),
          ...candidates.filter((p) => canonicalModel(p) !== pin.canonicalModel),
        ];
    }

    if (
      !pin &&
      role === "primary" &&
      String(body.model || "auto").startsWith("auto")
    ) {
      const policy = require("./orchestrator-bridge");
      const level = body._llmProxyDifficulty?.taskLevel || 1;
      const profile = {
        ...c.taskProfile,
        complexity: level >= 4 ? "COMPLEX" : level <= 2 ? "SIMPLE" : "MODERATE",
      };
      const inventory = {
        models: candidates.map((p) => ({
          id: p.upstream_model || String(p.model).replace(/^[^/]+\//, ""),
          availability: "exposed",
          efforts: p.supported_thinking_efforts || [],
        })),
      };
      const selection = await policy.rankTaskCandidates({ profile, inventory });
      const position = (p) => {
        const i = selection.ranked.findIndex(
          (r) =>
            r.api_id ===
            (p.upstream_model || String(p.model).replace(/^[^/]+\//, "")),
        );
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      };
      candidates = [...candidates].sort((a, b) => position(a) - position(b));
      c.classification = selection.classification;
      c.rolePlan = policy.selectProxyRoles({
        profile,
        capabilities: {
          tools: (body.tools || []).map((t) => t.function?.name),
        },
        budget: { maxAgents: 3 },
      });
    }
    if (freeOnly) candidates = candidates.filter(p => p.billing_class === "free_limited");
    const allocation = await router.acquire({
      identity: c.identity,
      role,
      candidates,
      event,
      profile: { effort: body.reasoning_effort },
    });
    const provider =
      all.find((p) => p.name === allocation.providerId) || proposed;
    await store.transaction(c.identity.key, (record) => {
      if (record.optimizerEnabled === undefined)
        record.optimizerEnabled = c.optimizerPreference;
      const policy = require("./orchestrator-bridge"),
        flows = require("./orchestration-state");
      if (!record.orchestration) {
        const profile = {
          ...c.taskProfile,
          complexity:
            c.taskProfile.risk === "critical"
              ? "CRITICAL"
              : body._llmProxyDifficulty?.taskLevel >= 4
                ? "COMPLEX"
                : "SIMPLE",
        };
        const rolePlan = policy.selectProxyRoles({
          profile,
          capabilities: {
            hostExecution: "unavailable",
            tools: (body.tools || []).map((t) => t.function?.name),
          },
          budget: { maxAgents: 3 },
        });
        record.orchestration = {
          rolePlan,
          flow: flows.createFlow({
            taskType: profile.task_type,
            revision: c.sourceRevision || "unverified",
            independentReview: rolePlan.reviewFloor === "required",
          }),
          enforcement:
            "Proxy agents are RO; native execution evidence requires trusted executor integration",
        };
      } else if (
        c.sourceRevision &&
        c.sourceRevision !== record.orchestration.flow.revision
      )
        record.orchestration.flow = flows.invalidateFlow(
          record.orchestration.flow,
          c.sourceRevision,
        );
      c.response?.setHeader?.(
        "X-LLM-Proxy-Review-Gate",
        record.orchestration.rolePlan.reviewFloor === "required"
          ? record.orchestration.flow.phase ===
            record.orchestration.flow.phases.length
            ? "verified"
            : "pending-executor-evidence"
          : "task-dependent",
      );
      return { record, result: null };
    });
    c.optimizerEnabled = router.inspect(c.identity.key).optimizerEnabled;
    c.allocation = allocation;
    c.role = role;
    stats.dispatches++;
    if (
      allocation.reason === "unavailable" ||
      allocation.reason === "capability_mismatch"
    )
      stats.fallbacks++;
    if (
      allocation.effort &&
      provider.supported_thinking_efforts?.includes(allocation.effort) &&
      body.reasoning_effort !== undefined
    )
      body.reasoning_effort = allocation.effort;
    const retrievalAvailable =
      compression &&
      c.optimizerEnabled !== false &&
      body.tools?.length > 0 &&
      (!body.tools.some((t) => t.function?.name === RETRIEVAL) ||
        body._llmProxyOwnRetrieval === true) &&
      body.stream !== true &&
      provider.protocol !== "windsurf" &&
      (provider.caps || []).includes("tools") &&
      body.tool_choice !== "none" &&
      !body.functions?.length;
    if (retrievalAvailable) {
      body._llmProxyOwnRetrieval = true;
      body.tools = [
        ...(body.tools || []).filter((t) => t.function?.name !== RETRIEVAL),
        RETRIEVAL_TOOL,
      ];
      c.retrievalAvailable = true;
      const prepared = optimizer.prepare({
        taskKey: c.identity.key,
        role,
        messages: body.messages || [],
        retrievalAvailable: true,
      });
      body.messages = prepared.messages;
      stats.compressedChars += Math.max(
        0,
        prepared.diagnostics.beforeChars - prepared.diagnostics.afterChars,
      );
    }
    const cache = prepareTaskCache({ body, allocation, provider });
    if (cache.cacheKey) body.prompt_cache_key = cache.cacheKey;
    c.prefixHash = cache.prefixHash;
    if (!accounts.beginHalfOpen(provider))
      throw Object.assign(
        new Error("Account recovery probe already in progress"),
        { code: "NO_ELIGIBLE_ROUTE" },
      );
    return provider;
  }
  async function recordFailure(provider, error) {
    const c = context.current();
    if (!c) return;
    services();
    const failure = classifyUpstreamFailure({
      providerKind: provider.family,
      status: Number(error.status || error.statusCode) || 0,
      errorBody: error.body || error.message || "",
      headers: error.headers || {},
      transportError: error.status || error.statusCode ? undefined : error,
      now: now(),
    });
    accounts.observe({ route: provider, failure });
    if (
      [
        "rate_limit",
        "credit_exhausted",
        "auth_expired",
        "transient",
        "capability_mismatch",
      ].includes(failure.kind)
    )
      await router.recordFailure({
        taskKey: c.identity.key,
        providerId: provider.name,
        reason:
          failure.kind === "capability_mismatch"
            ? "capability_mismatch"
            : "unavailable",
      });
  }

  function retryable(error) {
    const f = classifyUpstreamFailure({
      status: Number(error.status || error.statusCode) || 0,
      errorBody: error.body || "",
      headers: error.headers || {},
      transportError: error.status || error.statusCode ? undefined : error,
      now: now(),
    });
    return [
      "rate_limit",
      "credit_exhausted",
      "auth_expired",
      "transient",
      "capability_mismatch",
    ].includes(f.kind);
  }
  function restoreHiddenCalls(c, body) {
    const hidden = router.inspect(c.identity.key)?.hiddenCalls || [];
    if (!hidden.length) return;
    const output = [];
    for (const message of body.messages || []) {
      const ids = (message.tool_calls || []).map((t) => t.id);
      const entry =
        message.role === "assistant" &&
        hidden.find(
          (x) =>
            x.clientIds.every((id) => ids.includes(id)) &&
            !x.calls.some(
              (t) => t.function?.name === RETRIEVAL && ids.includes(t.id),
            ),
        );
      if (entry) {
        output.push({ ...message, tool_calls: entry.calls });
        for (const result of entry.results) {
          let text;
          try {
            text =
              result.errorContent ??
              originals
                .get({
                  taskKey: c.identity.key,
                  ref: result.ref,
                  start: result.start,
                  end: result.end,
                })
                .toString("utf8");
          } catch {
            text = JSON.stringify({ error: "Original no longer available" });
          }
          output.push({
            role: "tool",
            name: RETRIEVAL,
            tool_call_id: result.id,
            content: text,
          });
        }
      } else output.push(message);
    }
    body.messages = output;
  }
  async function resolveResponse(resp, body, dispatch) {
    const c = context.current();
    if (!c || !c.retrievalAvailable) return resp;
    let parsed;
    try {
      parsed = JSON.parse(resp.body);
    } catch {
      return resp;
    }
    const message = parsed.choices?.[0]?.message,
      calls = message?.tool_calls || [];
    const retrieval = calls.filter((t) => t.function?.name === RETRIEVAL),
      clientCalls = calls.filter((t) => t.function?.name !== RETRIEVAL);
    if (!retrieval.length) return resp;
    if (c.retrievalCalls + retrieval.length > 4)
      throw Object.assign(new Error("Original retrieval call limit reached"), {
        status: 422,
        code: "RETRIEVAL_BUDGET",
      });
    const results = [],
      saved = [];
    for (const call of retrieval) {
      c.retrievalCalls++;
      stats.retrievals++;
      let content;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        const start = Number(args.start || 0),
          end = args.end === undefined ? start + 32768 : Number(args.end);
        if (end - start > 32768)
          throw new Error("Request at most 32768 bytes per retrieval");
        content = originals
          .get({ taskKey: c.identity.key, ref: args.ref, start, end })
          .toString("utf8");
        saved.push({ id: call.id, ref: args.ref, start, end });
      } catch (e) {
        content = JSON.stringify({ error: e.message });
        saved.push({ id: call.id, errorContent: content });
      }
      results.push({
        role: "tool",
        tool_call_id: call.id,
        name: RETRIEVAL,
        content,
      });
    }
    if (clientCalls.length) {
      await store.transaction(c.identity.key, (record) => {
        record.hiddenCalls = [
          ...(record.hiddenCalls || []),
          { clientIds: clientCalls.map((t) => t.id), calls, results: saved },
        ].slice(-4);
        return { record, result: null };
      });
      message.tool_calls = clientCalls;
      return { ...resp, body: JSON.stringify(parsed) };
    }
    return dispatch({
      ...body,
      messages: [...(body.messages || []), message, ...results],
    });
  }

  async function recordDispatch(provider, response) {
    const c = context.current();
    if (!c) return response;
    let parsed;
    try {
      parsed = JSON.parse(response?.body);
    } catch {}
    const u = parsed?.usage;
    const input = u?.prompt_tokens ?? u?.input_tokens;
    const output = u?.completion_tokens ?? u?.output_tokens;
    const usage = await store.transaction(c.identity.key, (record) => {
      const total = record.usage || {
        inputTokens: 0,
        outputTokens: 0,
        observedDispatches: 0,
        unknownUsageDispatches: 0,
        costSavedUsd: null,
      };
      if (Number.isFinite(input) && Number.isFinite(output)) {
        total.inputTokens += input;
        total.outputTokens += output;
        total.observedDispatches++;
      } else total.unknownUsageDispatches++;
      record.usage = total;
      return {
        record,
        result: {
          ...total,
          scope: "task lifetime",
          attempts: record.dispatchAttempts || record.reservations.length,
          cache: require("./task-cache").cacheUsage(u),
        },
      };
    });
    if (parsed)
      return {
        ...response,
        body: JSON.stringify({ ...parsed, llm_proxy_usage: usage }),
      };
    return response;
  }
  async function reserveAgent(assignment) {
    const c = context.current();
    if (!c) throw new Error("Task context required");
    services();
    return store.transaction(c.identity.key, (record) => ({
      record: require("./orchestration-state").reserveAgent(
        record || {
          key: c.identity.key,
          models: [],
          roles: {},
          failed: [],
          reservations: [],
        },
        assignment,
      ),
      result: null,
    }));
  }
  async function recordGateEvidence(evidence) {
    const c = context.current();
    if (!c) throw new Error("Task context required");
    return store.transaction(c.identity.key, (record) => {
      if (!record?.orchestration)
        throw new Error("No active orchestration flow");
      record.orchestration.flow = require("./orchestration-state").advanceFlow(
        record.orchestration.flow,
        evidence,
      );
      return { record, result: null };
    });
  }
  const api = {
    inspectTask: () => {
      const c = context.current();
      return c ? router?.inspect(c.identity.key) : null;
    },
    recordGateEvidence,
    recordDispatch,
    setEligibility: (fn) => {
      eligibility = fn;
    },
    reserveAgent,
    recordSuccess: (provider) => accounts?.recordSuccess(provider),
    retryable,
    handle,
    beforeDispatch,
    recordFailure,
    orderCandidates,
    resolveResponse,
    signedHeaders,
    current: () => context.current(),
    diagnostics: () => ({
      bundle: require("../vendor/llm-orchestrator/provenance.json").sourceSha,
      stats: { ...stats },
      taskIdentity:
        "explicit or conversation anchor; anchor identity is heuristic",
      compression:
        "deterministic tool data with original retrieval on non-streaming tool-capable routes; streaming passthrough",
      accounts: accounts?.snapshot() || { state: "not initialized" },
      maxDistinctModelsPerTask: 3,
      roles:
        require("../vendor/llm-orchestrator/registries/agent-roles.json").roles.map(
          (r) => r.id,
        ),
      toolDiscovery:
        "Request-scoped; configured tools are not automatically callable",
      modelEvidence: "Account listing and successful inference are separate",
    }),
    close() {
      if (store) {
        store.close();
        accounts.close();
        originals.close();
      }
    },
  };
  return api;
}
module.exports = { createTaskRuntime, RETRIEVAL, RETRIEVAL_TOOL };
