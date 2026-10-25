"use strict";
const crypto = require("node:crypto");
const { digest } = require("./task-store");
function resolveTaskIdentity({
  clientScope,
  taskId,
  conversationId,
  parentTaskKey,
  previousTaskKey,
  conversationAnchor,
} = {}) {
  if (parentTaskKey || previousTaskKey)
    return {
      key: parentTaskKey || previousTaskKey,
      taskId: taskId || null,
      source: "lineage",
      confidence: "explicit",
    };
  const raw =
    taskId || conversationId || conversationAnchor || crypto.randomUUID();
  if (
    typeof raw !== "string" ||
    /[\r\n\0]/.test(raw) ||
    String(raw).length > 512 ||
    String(clientScope || "").length > 512
  )
    throw Object.assign(new Error("Task identity too long"), {
      code: "INVALID_TASK_ID",
    });
  return {
    key: digest(JSON.stringify([clientScope || "local", raw])),
    taskId: String(raw),
    source: taskId
      ? "explicit"
      : conversationId
        ? "conversation"
        : conversationAnchor
          ? "anchor"
          : "generated",
    confidence:
      taskId || conversationId
        ? "explicit"
        : conversationAnchor
          ? "heuristic"
          : "request",
  };
}
function canonicalModel(p) {
  if (p.canonical_model) return p.canonical_model;
  const id = p.upstream_model || String(p.model || "").replace(/^[^/]+\//, "");
  const lab = /^gpt-|^o[134](?:-|$)/.test(id)
    ? "openai"
    : /^claude-/.test(id)
      ? "anthropic"
      : /^gemini-/.test(id)
        ? "google"
        : p.family || String(p.model || "").split("/")[0];
  return lab + "/" + id;
}
function createTaskRouter({ store, now = Date.now } = {}) {
  async function acquire({
    identity,
    role = "primary",
    profile = {},
    candidates = [],
    event = "continue",
  } = {}) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(role) ||
      ["constructor", "prototype"].includes(role)
    )
      throw new Error("Invalid role");
    return store.transaction(identity.key, (previous) => {
      const record = previous || {
        key: identity.key,
        createdAt: now(),
        models: [],
        helperModels: {},
        primaryModels: [],
        roles: {},
        failed: [],
        reservations: [],
        identitySource: identity.source,
      };
      record.modelHistory = [...new Set([
        ...(record.modelHistory || []),
        ...record.models,
        ...Object.values(record.helperModels || {}).flat(),
        ...(record.primaryModels || []),
        ...record.reservations.map(r => r.model).filter(Boolean),
      ])];
      if (
        Array.isArray(record.models) &&
        Array.isArray(record.reservations) &&
        Array.isArray(record.failed) &&
        record.failed.length > 0
      ) {
        const activeOrHealthyModels = new Set();
        for (const r of record.reservations) {
          if (r?.model && !record.failed.includes(r.providerId)) {
            activeOrHealthyModels.add(r.model);
          }
        }
        record.models = record.models.filter((m) => activeOrHealthyModels.has(m));
      }
      const pin = record.roles[role];
      const hiddenRole = role === "assessment" || role === "memory";
      if (hiddenRole && !record.helperModels) record.helperModels = {};
      if (hiddenRole && !Array.isArray(record.helperModels[role])) record.helperModels[role] = [];
      const trackedModels = hiddenRole ? record.helperModels[role] : record.models;
      // When all primary models have failed, reset the failed list so the
      // task can recover instead of being permanently blocked.
      if (role === "primary" && Array.isArray(record.primaryModels) && record.primaryModels.length >= 3) {
        const retiredPrimary = new Set((record.retiredModels || []).map((r) => r.model));
        const allFailed = record.primaryModels.every((m) => retiredPrimary.has(m) || record.failed.some((f) => f === m || f.includes(m.split("/").pop())));
        if (allFailed && record.failed.length > 0) {
          console.log(`TASK-RECOVER: all ${record.primaryModels.length} primary models failed; resetting failed list`);
          record.failed = [];
          record.retiredModels = (record.retiredModels || []).filter((r) => !record.primaryModels.includes(r.model));
        }
      }
      const viable = candidates.filter(
        (p) => !record.failed.includes(p.name || p.providerId),
      );
      let chosen =
        pin &&
        viable.find(
          (p) =>
            (p.name || p.providerId) === pin.providerId &&
            canonicalModel(p) === pin.canonicalModel &&
            (p.upstream_model || p.model) === pin.upstreamModel,
        );
      if (
        !chosen &&
        pin &&
        ![
          "unavailable",
          "capability_mismatch",
          "specialist",
          "independent_review",
        ].includes(event)
      )
        throw Object.assign(
          new Error("Pinned route cannot serve this continuation"),
          { code: "TASK_PIN_UNAVAILABLE" },
        );
      if (!chosen && pin)
        chosen = viable.find((p) => canonicalModel(p) === pin.canonicalModel);
      // The ceiling covers functional models, not all models ever attempted.
      // Runtime supplies eligible candidates and establishes the failure event;
      // a routine continuation or specialist request cannot release a slot.
      if (!chosen && pin && ["unavailable", "capability_mismatch"].includes(event)) {
        const target = hiddenRole ? record.helperModels[role] : record.models;
        if (target) {
          const index = target.indexOf(pin.canonicalModel);
          if (index >= 0) target.splice(index, 1);
        }
        record.retiredModels = [...(record.retiredModels || []), {
          model: pin.canonicalModel, providerId: pin.providerId, reason: event, at: now(),
        }].slice(-100);
      }
      // Hard cap: at most 3 distinct primary models per task. Once all three
      // have been tried, do not introduce a fourth; prefer an already-tried
      // (possibly recovering) model or fail cleanly instead of churning.
      if (role === "primary" && !record.primaryModels) record.primaryModels = [];
      const primaryModelCap = role === "primary" && Array.isArray(record.primaryModels) && record.primaryModels.length >= 3;
      const retiredPrimary = new Set((record.retiredModels || []).map((r) => r.model));
      const allPrimaryFailed = primaryModelCap && (record.primaryModels || []).every((m) => retiredPrimary.has(m) || record.failed.some((f) => f === m || f.includes(m.split("/").pop())));
      if (!chosen)
        chosen = viable.find(
          (p) =>
            trackedModels.includes(canonicalModel(p)) ||
            (!primaryModelCap && trackedModels.length < 3) ||
            (primaryModelCap && allPrimaryFailed),
        );
      if (!chosen && primaryModelCap && !allPrimaryFailed)
        chosen = viable.find((p) => (record.primaryModels || []).includes(canonicalModel(p)));
      if (!chosen)
        throw Object.assign(
          new Error(
            trackedModels.length >= 3
              ? "Task functional model limit exhausted"
              : "No eligible route",
          ),
          {
            code:
              trackedModels.length >= 3
                ? "TASK_MODEL_BUDGET_EXHAUSTED"
                : "NO_ELIGIBLE_ROUTE",
          },
        );
      const canonical = canonicalModel(chosen);
      if (!trackedModels.includes(canonical) && trackedModels.length >= 3)
        throw Object.assign(new Error("Task functional model limit exhausted"), {
          code: "TASK_MODEL_BUDGET_EXHAUSTED",
        });
      if (!trackedModels.includes(canonical)) {
        if (hiddenRole) record.helperModels[role].push(canonical);
        else record.models.push(canonical);
      }
      if (role === "primary" && !(record.primaryModels || []).includes(canonical)) {
        (record.primaryModels ||= []).push(canonical);
      }
      if (!record.modelHistory.includes(canonical)) record.modelHistory.push(canonical);
      const allocation = {
        taskKey: identity.key,
        canonicalModel: canonical,
        providerId: chosen.name || chosen.providerId,
        accountRef:
          chosen.account_ref || chosen.accountRef || chosen.key_env || null,
        upstreamModel: chosen.upstream_model || chosen.model,
        effort: pin?.effort ?? profile.effort ?? chosen.thinking_effort ?? null,
        role,
        inventoryRevision: profile.inventoryRevision || null,
        reason: pin
          ? chosen.name === pin.providerId
            ? "task_pin"
            : event
          : event,
        reservationId: crypto.randomUUID(),
      };
      record.roles[role] = allocation;
      record.dispatchAttempts = (record.dispatchAttempts || 0) + 1;
      record.updatedAt = now();
      record.reservations.push({
        id: allocation.reservationId,
        providerId: allocation.providerId,
        model: canonical,
      });
      record.reservations = record.reservations.slice(-100);
      return { record, result: allocation };
    });
  }
  async function recordFailure({ taskKey, providerId, reservationId, reason }) {
    return store.transaction(taskKey, (record) => {
      if (!record) throw new Error("Missing task state");
      const id =
        providerId ||
        record.reservations.find((r) => r.id === reservationId)?.providerId;
      if (
        id &&
        ["unavailable", "capability_mismatch"].includes(reason) &&
        !record.failed.includes(id)
      )
        record.failed.push(id);
      // Unavailable attempts release their functional slot, including models
      // that worked earlier but have since failed. Historical participation
      // remains in modelHistory/reservations; healthy models keep their slots.
      if (id && Array.isArray(record.models) && Array.isArray(record.reservations)) {
        for (let i = record.reservations.length - 1; i >= 0; i -= 1) {
          const reservation = record.reservations[i];
          if (reservation?.providerId !== id) continue;
          if (typeof reservation.model === "string") {
            record.models = record.models.filter((m) => m !== reservation.model);
          }
          break;
        }
      }
      return { record, result: null };
    });
  }
  return { acquire, recordFailure, inspect: (key) => store.get(key) };
}
module.exports = { resolveTaskIdentity, canonicalModel, createTaskRouter };
