"use strict";
const { createTaskStore } = require("./task-store");
function accountKey(route) {
  return JSON.stringify([
    route.family || route.providerId || "unknown",
    route.account_ref ||
      route.accountRef ||
      route.key_env ||
      route.name ||
      route.providerId,
  ]);
}
function bucketKey(route) {
  return accountKey(route) + "|" + (route.quota_bucket || "account");
}
function createAccountAvailabilityStore({ dataDir, now = Date.now } = {}) {
  const store = createTaskStore({ dataDir });
  const halfOpen = new Set();
  const keys = (route) => [
    accountKey(route),
    bucketKey(route),
    "route|" + (route.name || route.routeId),
  ];
  function observe({ route, failure }) {
    if (
      !failure ||
      ![
        "rate_limit",
        "credit_exhausted",
        "auth_expired",
        "transient",
        "capability_mismatch",
      ].includes(failure.kind)
    )
      return;
    const key =
      failure.scope === "account"
        ? accountKey(route)
        : failure.scope === "quota_bucket"
          ? bucketKey(route)
          : "route|" + (route.name || route.routeId);
    const retryAt =
      failure.retryAt ||
      failure.resetAt ||
      (["rate_limit", "transient"].includes(failure.kind)
        ? now() + 60000
        : null);
    store.updateSync(key, () => ({
      record: {
        kind: failure.kind,
        retryAt,
        observedAt: now(),
        evidence: failure.evidence || null,
      },
      result: null,
    }));
    for (const k of keys(route)) halfOpen.delete(k);
  }
  function isEligible(route) {
    return keys(route).every((key) => {
      const r = store.get(key);
      return (
        !halfOpen.has(key) && (!r || (r.retryAt !== null && now() >= r.retryAt))
      );
    });
  }
  function beginHalfOpen(route) {
    if (!isEligible(route)) return false;
    for (const key of keys(route)) {
      const r = store.get(key);
      if (r && r.kind !== "ready") halfOpen.add(key);
    }
    return true;
  }
  function recordSuccess(route) {
    for (const key of keys(route)) {
      const r = store.get(key);
      if (halfOpen.has(key)) {
        store.updateSync(key, () => ({
          record: {
            kind: "ready",
            retryAt: 0,
            observedAt: now(),
            evidence: "successful inference",
          },
          result: null,
        }));
        halfOpen.delete(key);
      }
    }
  }
  function releaseProbe(route) {
    for (const key of keys(route)) halfOpen.delete(key);
  }
  function reset({ accountKey: key, quotaBucket = "account", evidence }) {
    if (!evidence) throw new Error("Positive reset evidence required");
    for (const k of [key, key + "|" + quotaBucket]) {
      store.updateSync(k, () => ({
        record: { kind: "ready", retryAt: 0, evidence },
        result: null,
      }));
      halfOpen.delete(k);
    }
  }
  return {
    observe,
    isEligible,
    beginHalfOpen,
    recordSuccess,
    releaseProbe,
    reset,
    snapshot: () => ({
      storage: "persistent",
      accountBalances: "unknown unless observed",
    }),
    close: () => store.close(),
  };
}
module.exports = { createAccountAvailabilityStore, accountKey };
