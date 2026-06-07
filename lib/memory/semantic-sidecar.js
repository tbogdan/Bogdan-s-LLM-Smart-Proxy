"use strict";

const { GraphitiMcpClient } = require("./graphiti-mcp-client");

function isEnabled(env) {
  return String(env.GRAPHITI_MCP_ENABLED || "").trim().toLowerCase() === "true";
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truncate(value, max = 2000) {
  const text = value == null ? "" : String(value);
  return text.length > max ? text.substring(0, max) : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SemanticMemorySidecar {
  constructor(env = process.env, options = {}) {
    this.enabled = isEnabled(env);
    this.ledger = options.ledger || null;
    this.client = options.client || new GraphitiMcpClient(env);
    this.batchSize = toInt(env.GRAPHITI_MCP_OUTBOX_BATCH, 5);
    this.maxDrainBatches = toInt(env.GRAPHITI_MCP_OUTBOX_MAX_DRAIN_BATCHES, 1);
    this.drainRescheduleMs = toInt(env.GRAPHITI_MCP_OUTBOX_DRAIN_RESCHEDULE_MS, 60000);
    this.retryAfterMs = toInt(env.GRAPHITI_MCP_RETRY_AFTER_MS, 60000);
    this.warmupRetries = toInt(env.GRAPHITI_MCP_WARMUP_RETRIES, 45);
    this.warmupRetryMs = toInt(env.GRAPHITI_MCP_WARMUP_RETRY_MS, 1000);
    this.draining = false;
    this.drainAgain = false;
    this.drainTimer = null;
    this.initializing = null;
  }

  health() {
    const clientHealth = typeof this.client?.health === "function" ? this.client.health() : null;
    if (this.enabled && clientHealth && clientHealth.available === false && typeof this.client?.ensureInitialized === "function") {
      this.initialize().catch(() => {});
    }
    return {
      enabled: this.enabled,
      outbox: !!this.ledger,
      client: clientHealth,
    };
  }

  async initialize(options = {}) {
    if (!this.enabled || typeof this.client?.ensureInitialized !== "function") return;
    if (this.initializing) return this.initializing;
    const retries = Number.isFinite(options.retries) ? options.retries : this.warmupRetries;
    const retryMs = Number.isFinite(options.retryMs) ? options.retryMs : this.warmupRetryMs;
    this.initializing = (async () => {
      let lastError = null;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          await this.client.ensureInitialized();
          return;
        } catch (error) {
          lastError = error;
          if (attempt >= retries) break;
          await sleep(retryMs);
        }
      }
      throw lastError;
    })();
    try {
      return await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async enqueueMemoryEvents(session, events = []) {
    if (!this.enabled || !this.ledger?.enqueueGraphitiOutbox) return;
    for (const event of events || []) {
      if (!event?.id) continue;
      await this.ledger.enqueueGraphitiOutbox(session, memoryEventEpisode(session, event));
    }
    this.drainSoon();
  }

  async enqueueArchives(session, archives = []) {
    if (!this.enabled || !this.ledger?.enqueueGraphitiOutbox) return;
    for (const archive of archives || []) {
      if (!archive?.uri) continue;
      await this.ledger.enqueueGraphitiOutbox(session, archiveEpisode(session, archive));
    }
    this.drainSoon();
  }

  drainSoon() {
    if (!this.enabled) return;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    setTimeout(() => {
      this.drainOnce().catch(() => {});
    }, 0);
  }

  drainLater() {
    if (!this.enabled || this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainOnce().catch(() => {});
    }, this.drainRescheduleMs);
    if (typeof this.drainTimer.unref === "function") this.drainTimer.unref();
  }

  async drainOnce() {
    if (!this.enabled || !this.ledger?.claimGraphitiOutbox || !this.client?.addEpisode) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    let quietBacklogRemains = false;
    try {
      let keepDraining = false;
      let batches = 0;
      do {
        this.drainAgain = false;
        const items = await this.ledger.claimGraphitiOutbox(this.batchSize);
        batches += 1;
        for (const item of items || []) {
          try {
            await this.client.addEpisode({
              id: item.id,
              project: item.project,
              name: item.name,
              body: item.body,
              sourceDescription: item.source_description,
            });
            if (this.ledger.markGraphitiOutboxDone) await this.ledger.markGraphitiOutboxDone(item.id);
          } catch (error) {
            if (this.ledger.markGraphitiOutboxFailed) {
              await this.ledger.markGraphitiOutboxFailed(item.id, error?.message || error, this.retryAfterMs);
            }
          }
        }
        const claimedFullBatch = (items || []).length >= this.batchSize;
        keepDraining = this.drainAgain || (claimedFullBatch && batches < this.maxDrainBatches);
        quietBacklogRemains = claimedFullBatch && !this.drainAgain && !keepDraining;
      } while (keepDraining);
    } finally {
      this.draining = false;
      if (quietBacklogRemains) this.drainLater();
    }
  }

  async search(session, marker = {}) {
    if (!this.enabled || !marker?.query || !this.client?.search) return "";
    const results = await this.client.search({
      project: session?.projectName || "unknown",
      query: marker.query,
      limit: 6,
    });
    if (!results?.length) return "";
    return ["Semantic graph memory:", ...results.map((item) => `- ${item}`)].join("\n");
  }
}

function memoryEventEpisode(session, event = {}) {
  const id = `memory-event:${event.id}`;
  const body = [
    `project: ${session?.projectName || event.project || "unknown"}`,
    `operation: ${event.op || "note"}`,
    `type: ${event.type || "note"}`,
    `target: ${event.target || ""}`,
    `confidence: ${event.confidence || "medium"}`,
    `status: ${event.status || "active"}`,
    `provider: ${event.provider || ""}`,
    `at: ${event.at || new Date().toISOString()}`,
    "",
    truncate(event.summary || event.text || event.content || "", 4000),
  ].join("\n");
  return {
    id,
    kind: "memory_event",
    name: truncate(`${session?.projectName || "unknown"} ${event.op || "memory"} ${event.target || ""}`.trim(), 300),
    body,
    sourceDescription: "llm-proxy memory governance event",
    at: event.at,
  };
}

function archiveEpisode(session, archive = {}) {
  return {
    id: `memory-archive:${archive.uri}`,
    kind: "memory_archive",
    name: truncate(archive.title || `${session?.projectName || "unknown"} compacted context`, 300),
    body: [
      `project: ${session?.projectName || "unknown"}`,
      `archive_uri: ${archive.uri || ""}`,
      `kind: ${archive.kind || "episode"}`,
      `summary: ${archive.summary || ""}`,
      `message_count: ${archive.message_count || ""}`,
      "",
      truncate(archive.content || archive.preview || "", 50000),
    ].join("\n"),
    sourceDescription: "llm-proxy compacted context archive",
    at: new Date().toISOString(),
  };
}

module.exports = {
  SemanticMemorySidecar,
  archiveEpisode,
  memoryEventEpisode,
};
