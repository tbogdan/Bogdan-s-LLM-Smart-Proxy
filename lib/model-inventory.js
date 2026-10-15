"use strict";
const { digest } = require("./task-store");
function normalizeInventory({
  observations = [],
  observedAt = new Date().toISOString(),
} = {}) {
  const models = observations
    .filter((x) => x && typeof (x.id || x.upstreamModel) === "string")
    .map((x) => ({
      id: x.id || x.upstreamModel,
      providerId: x.providerId || x.family || null,
      accountRef: x.accountRef || null,
      routeId: x.routeId || null,
      canonicalModel: x.canonicalModel || null,
      upstreamModel: x.upstreamModel || x.id,
      capabilities: x.capabilities || [],
      efforts: x.efforts || [],
      contextWindow: x.contextWindow || null,
      availability: ["configured", "exposed", "verified"].includes(
        x.availability,
      )
        ? x.availability
        : "configured",
      source: x.source || "unknown",
      observedAt: x.observedAt || observedAt,
    }));
  return {
    revision: digest(JSON.stringify(models)),
    observedAt,
    models,
    limitations: models.some((m) => m.availability !== "verified")
      ? ["Model listing is not successful inference proof."]
      : [],
  };
}
module.exports = { normalizeInventory };
