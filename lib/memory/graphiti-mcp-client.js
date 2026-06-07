"use strict";

const crypto = require("crypto");

function toBool(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truncate(value, max = 2000) {
  const text = value == null ? "" : String(value);
  return text.length > max ? text.substring(0, max) : text;
}

function parseResponseText(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  if (raw.startsWith("event:") || raw.includes("\ndata:")) {
    const payloads = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]");
    if (payloads.length === 0) return {};
    return JSON.parse(payloads[payloads.length - 1]);
  }
  return JSON.parse(raw);
}

function normalizeToolContent(result) {
  if (result == null) return [];
  if (Array.isArray(result)) return result.map((item) => JSON.stringify(item)).filter(Boolean);
  if (typeof result === "string") return [result].filter(Boolean);
  const content = Array.isArray(result.content) ? result.content : [];
  if (!content.length && typeof result === "object") return [JSON.stringify(result)];
  return content
    .map((part) => {
      if (part == null) return "";
      if (typeof part === "string") return part;
      if (typeof part.text === "string") return part.text;
      if (part.json !== undefined) return typeof part.json === "string" ? part.json : JSON.stringify(part.json);
      return "";
    })
    .filter(Boolean)
    .map((text) => String(text).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function uuidFromString(value) {
  const bytes = crypto.createHash("sha1").update(String(value || "llm-proxy-memory")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

class GraphitiMcpClient {
  constructor(env = process.env, options = {}) {
    this.enabled = toBool(env.GRAPHITI_MCP_ENABLED);
    this.url = env.GRAPHITI_MCP_URL || "http://graphiti-mcp:8000/mcp/";
    this.groupId = env.GRAPHITI_MCP_GROUP_ID || env.GROUP_ID || "llm-proxy";
    this.timeoutMs = toInt(env.GRAPHITI_MCP_TIMEOUT_MS, 1200);
    this.writeTimeoutMs = toInt(env.GRAPHITI_MCP_WRITE_TIMEOUT_MS, 5000);
    this.searchTimeoutMs = toInt(env.GRAPHITI_MCP_SEARCH_TIMEOUT_MS, 1200);
    this.protocolVersion = env.GRAPHITI_MCP_PROTOCOL_VERSION || "2024-11-05";
    this.addToolName = env.GRAPHITI_MCP_ADD_TOOL || "add_memory";
    this.sendUuid = toBool(env.GRAPHITI_MCP_SEND_UUID);
    this.fetchImpl = options.fetchImpl || global.fetch;
    this.nextId = 0;
    this.sessionId = null;
    this.initialized = false;
    this.initPromise = null;
    this.state = {
      enabled: this.enabled,
      available: false,
      initialized: false,
      last_ok_at: null,
      last_error: null,
    };
  }

  health() {
    return {
      store: "graphiti-mcp",
      url: this.url,
      group_id: this.groupId,
      ...this.state,
    };
  }

  async ensureInitialized(timeoutMs = this.timeoutMs) {
    if (!this.enabled || this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.initialize(timeoutMs).finally(() => {
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  async initialize(timeoutMs = this.timeoutMs) {
    await this.rpc("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: {
        name: "llm-proxy",
        version: "1.0.0",
      },
    }, { timeoutMs, skipInitialize: true });
    this.initialized = true;
    this.state.initialized = true;
    try {
      await this.notify("notifications/initialized", {}, timeoutMs);
    } catch {}
  }

  async notify(method, params = {}, timeoutMs = this.timeoutMs) {
    return this.rpc(method, params, {
      timeoutMs,
      skipInitialize: true,
      notification: true,
    });
  }

  async rpc(method, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    if (!this.enabled) return { skipped: true };
    if (!options.skipInitialize) await this.ensureInitialized(timeoutMs);
    if (typeof this.fetchImpl !== "function") throw new Error("fetch is unavailable for Graphiti MCP");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const id = options.notification ? undefined : this.nextId += 1;
    const payload = options.notification
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id, method, params };
    try {
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      const sessionHeader = response.headers?.get?.("mcp-session-id");
      if (sessionHeader) this.sessionId = sessionHeader;
      if (!response.ok) throw new Error(`Graphiti MCP HTTP ${response.status}: ${truncate(await response.text(), 300)}`);
      if (options.notification) {
        this.state.available = true;
        this.state.last_ok_at = new Date().toISOString();
        this.state.last_error = null;
        return {};
      }
      const json = parseResponseText(await response.text());
      if (json.error) throw new Error(json.error.message || "Graphiti MCP JSON-RPC error");
      this.state.available = true;
      this.state.last_ok_at = new Date().toISOString();
      this.state.last_error = null;
      return json.result || {};
    } catch (error) {
      this.state.available = false;
      this.state.last_error = truncate(error?.message || error, 300);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async callTool(name, args = {}, timeoutMs = this.timeoutMs) {
    return this.rpc("tools/call", { name, arguments: args }, { timeoutMs });
  }

  async callToolChecked(name, args = {}, timeoutMs = this.timeoutMs) {
    const result = await this.callTool(name, args, timeoutMs);
    if (result?.isError) {
      const detail = normalizeToolContent(result).join("; ") || "tool returned an error";
      throw new Error(`${name}: ${detail}`);
    }
    return result;
  }

  async addEpisode(episode = {}) {
    if (!this.enabled) return { skipped: true };
    const id = truncate(episode.id || `llm-proxy-${Date.now()}`, 300);
    const body = [
      `project=${episode.project || "unknown"}`,
      `source_id=${id}`,
      "",
      episode.body || "",
    ].join("\n");
    const args = {
      name: truncate(episode.name || "llm-proxy memory episode", 200),
      episode_body: truncate(body, 50000),
      source: "text",
      source_description: truncate(episode.sourceDescription || "llm-proxy memory", 300),
      group_id: this.groupId,
    };
    if (this.sendUuid) args.uuid = uuidFromString(id);
    try {
      return await this.callToolChecked(this.addToolName, args, this.writeTimeoutMs);
    } catch (error) {
      if (this.addToolName === "add_memory" && /Unknown tool:\s*add_memory/i.test(error?.message || "")) {
        return this.callToolChecked("add_episode", args, this.writeTimeoutMs);
      }
      throw error;
    }
  }

  async search({ project, query, limit = 6 } = {}) {
    if (!this.enabled || !query) return [];
    try {
      const scopedQuery = `${project || "unknown"} ${query}`.trim();
      const [facts, nodes] = await Promise.allSettled([
        this.callToolChecked("search_facts", { query: scopedQuery, group_ids: [this.groupId], max_facts: limit }, this.searchTimeoutMs),
        this.callToolChecked("search_nodes", { query: scopedQuery, group_ids: [this.groupId], max_nodes: limit }, this.searchTimeoutMs),
      ]);
      return [facts, nodes]
        .filter((item) => item.status === "fulfilled")
        .flatMap((item) => normalizeToolContent(item.value))
        .slice(0, limit * 2);
    } catch {
      return [];
    }
  }

  async getStatus() {
    if (!this.enabled) return { skipped: true };
    try {
      return await this.callTool("get_status", {}, this.timeoutMs);
    } catch {
      return null;
    }
  }
}

module.exports = {
  GraphitiMcpClient,
  normalizeToolContent,
  parseResponseText,
  uuidFromString,
};
