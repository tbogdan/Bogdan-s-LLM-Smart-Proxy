"use strict";

function truncate(value, max = 2000) {
  const text = value == null ? "" : String(value);
  return text.length > max ? text.substring(0, max) : text;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && (part.type === "text" || part.type === "input_text" || part.type === "output_text"))
      .map((part) => part.text || "")
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function normalizeTokens(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9_.:/-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 12);
}

function errorMessage(error) {
  return truncate(error?.message || error, 300);
}

function renderArchiveContent(messages = [], maxChars = 30000) {
  const lines = [];
  for (const message of messages || []) {
    if (!message || message.role === "system") continue;
    const label = [message.role || "unknown", message.name].filter(Boolean).join(":");
    const text = contentToText(message.content).replace(/\s+/g, " ").trim();
    if (text) lines.push(`[${label}] ${text}`);
  }

  const rendered = lines.join("\n");
  if (!Number.isFinite(maxChars) || maxChars <= 0 || rendered.length <= maxChars) return rendered;
  const marker = "\n[archive truncated]";
  if (maxChars <= marker.length) return rendered.substring(0, maxChars);
  const budget = maxChars - marker.length;
  const perLine = Math.max(24, Math.floor((budget - Math.max(0, lines.length - 1)) / Math.max(1, lines.length)));
  const shortened = lines.map((line) => (line.length > perLine ? `${line.substring(0, perLine - 3)}...` : line)).join("\n");
  if (shortened.length <= budget) return `${shortened}${marker}`;
  return `${shortened.substring(0, budget)}${marker}`;
}

function summarizeArchiveMessages(messages = []) {
  const nonSystem = (messages || []).filter((message) => message?.role !== "system");
  const roles = [...new Set(nonSystem.map((message) => message.role || "unknown"))];
  return `${nonSystem.length} non-system messages archived${roles.length ? ` (${roles.join(", ")})` : ""}`;
}

function excerptForQuery(text, tokens = [], maxChars = 700) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  const hit = tokens.map((token) => lower.indexOf(token)).filter((idx) => idx >= 0).sort((a, b) => a - b)[0];
  if (hit == null) return value.substring(0, maxChars);
  const start = Math.max(0, hit - Math.floor(maxChars / 3));
  const excerpt = value.substring(start, start + maxChars);
  return `${start > 0 ? "..." : ""}${excerpt}${start + maxChars < value.length ? "..." : ""}`;
}

class Neo4jMemoryStore {
  constructor(env = process.env) {
    this.uri = env.GRAPHITI_NEO4J_URI || env.NEO4J_URI || "bolt://graphiti-neo4j:7687";
    this.user = env.GRAPHITI_NEO4J_USER || env.NEO4J_USER || "neo4j";
    this.password = env.GRAPHITI_NEO4J_PASSWORD || env.NEO4J_PASSWORD || "graphiti-memory-local";
    this.database = env.GRAPHITI_NEO4J_DATABASE || env.NEO4J_DATABASE || "neo4j";
    this.driver = null;
    this.neo4j = null;
    this.initPromise = null;
    this.warned = false;
    this.state = {
      available: false,
      initialized: false,
      uri: this.uri,
      database: this.database,
      last_ok_at: null,
      last_error: null,
    };
  }

  health() {
    return {
      store: "neo4j",
      available: this.state.available,
      initialized: this.state.initialized,
      uri: this.state.uri,
      database: this.state.database,
      last_ok_at: this.state.last_ok_at,
      last_error: this.state.last_error,
    };
  }

  async ensure() {
    if (this.state.initialized && this.driver) return;
    if (!this.initPromise) {
      this.initPromise = this.initialize().finally(() => {
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  async initialize() {
    try {
      this.neo4j = require("neo4j-driver");
      if (!this.driver) {
        this.driver = this.neo4j.driver(this.uri, this.neo4j.auth.basic(this.user, this.password));
      }
      await this.driver.verifyConnectivity();
      const session = this.driver.session({
        database: this.database,
        defaultAccessMode: this.neo4j.session.WRITE,
      });
      try {
        await session.run("CREATE CONSTRAINT memory_session_id IF NOT EXISTS FOR (s:MemorySession) REQUIRE s.id IS UNIQUE");
        await session.run("CREATE CONSTRAINT memory_event_id IF NOT EXISTS FOR (e:MemoryEvent) REQUIRE e.id IS UNIQUE");
        await session.run("CREATE CONSTRAINT memory_archive_id IF NOT EXISTS FOR (a:MemoryArchive) REQUIRE a.uri IS UNIQUE");
        await session.run("CREATE CONSTRAINT graphiti_outbox_id IF NOT EXISTS FOR (o:GraphitiOutbox) REQUIRE o.id IS UNIQUE");
      } finally {
        await session.close();
      }
      this.state.available = true;
      this.state.initialized = true;
      this.state.last_ok_at = new Date().toISOString();
      this.state.last_error = null;
      this.warned = false;
    } catch (error) {
      this.state.available = false;
      this.state.initialized = false;
      this.state.last_error = errorMessage(error);
      if (!this.warned) {
        this.warned = true;
        console.warn(`[memory] Neo4j unavailable at ${this.uri}: ${this.state.last_error}`);
      }
      throw error;
    }
  }

  async runRead(query, params = {}) {
    await this.ensure();
    const session = this.driver.session({
      database: this.database,
      defaultAccessMode: this.neo4j.session.READ,
    });
    try {
      const result = await session.run(query, params);
      this.state.available = true;
      this.state.last_ok_at = new Date().toISOString();
      this.state.last_error = null;
      return result;
    } catch (error) {
      this.state.available = false;
      this.state.last_error = errorMessage(error);
      throw error;
    } finally {
      await session.close();
    }
  }

  async runWrite(query, params = {}) {
    await this.ensure();
    const session = this.driver.session({
      database: this.database,
      defaultAccessMode: this.neo4j.session.WRITE,
    });
    try {
      const result = await session.run(query, params);
      this.state.available = true;
      this.state.last_ok_at = new Date().toISOString();
      this.state.last_error = null;
      return result;
    } catch (error) {
      this.state.available = false;
      this.state.last_error = errorMessage(error);
      throw error;
    } finally {
      await session.close();
    }
  }

  async recordSession(session) {
    if (!session?.id) return;
    await this.runWrite(
      `
      MERGE (s:MemorySession {id: $id})
      SET s.project = $project,
          s.request_count = $requestCount,
          s.updated_at = $at
      `,
      {
        id: session.id,
        project: session.projectName || "unknown",
        requestCount: session.requestCount || 0,
        at: new Date().toISOString(),
      },
    );
  }

  async recordMemoryOps(session, reqBody, events = []) {
    if (!session?.id || !Array.isArray(events) || events.length === 0) return;
    await this.recordSession(session);
    for (const event of events) {
      const id = event.id || `${session.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const payload = {
        id,
        sessionId: session.id,
        project: session.projectName || "unknown",
        op: truncate(event.op, 80),
        target: truncate(event.target, 300),
        type: truncate(event.type, 80),
        confidence: truncate(event.confidence || "medium", 40),
        status: truncate(event.status || "active", 40),
        provider: truncate(event.provider || reqBody?._servedProvider || "", 120),
        summary: truncate(event.summary || event.text || event.content || "", 2000),
        at: event.at || new Date().toISOString(),
      };
      await this.runWrite(
        `
        MATCH (s:MemorySession {id: $sessionId})
        MERGE (e:MemoryEvent {id: $id})
        SET e += $payload
        MERGE (s)-[:HAS_MEMORY]->(e)
        `,
        { sessionId: session.id, id, payload },
      );
      if (payload.op === "user_correction" && payload.target) {
        await this.runWrite(
          `
          MATCH (old:MemoryEvent)
          WHERE old.target = $target
            AND old.id <> $id
            AND coalesce(old.status, "active") <> "superseded"
            AND (
              ($project <> "unknown" AND old.project = $project)
              OR EXISTS {
                MATCH (:MemorySession {id: $sessionId})-[:HAS_MEMORY]->(old)
              }
            )
          SET old.status = "superseded",
              old.superseded_by = $id,
              old.superseded_at = $at
          `,
          { sessionId: session.id, project: payload.project, target: payload.target, id, at: payload.at },
        );
      }
    }
  }

  async recordArchives(session, archives = []) {
    if (!session?.id || !Array.isArray(archives) || archives.length === 0) return;
    await this.recordSession(session);
    for (const archive of archives) {
      await this.runWrite(
        `
        MATCH (s:MemorySession {id: $sessionId})
        MERGE (a:MemoryArchive {uri: $uri})
        SET a.project = $project,
            a.title = $title,
            a.kind = $kind,
            a.summary = $summary,
            a.preview = $preview,
            a.content = $content,
            a.message_count = $messageCount,
            a.at = $at
        MERGE (s)-[:HAS_ARCHIVE]->(a)
        `,
        {
          sessionId: session.id,
          uri: truncate(archive.uri, 300),
          project: session.projectName || "unknown",
          title: truncate(archive.title, 300),
          kind: truncate(archive.kind || "episode", 80),
          summary: truncate(archive.summary, 2000),
          preview: truncate(archive.preview, 500),
          content: truncate(archive.content, 50000),
          messageCount: Number.isFinite(archive.message_count) ? archive.message_count : null,
          at: new Date().toISOString(),
        },
      );
    }
  }

  async enqueueGraphitiOutbox(session, episode) {
    if (!session?.id || !episode?.id) return;
    await this.recordSession(session);
    await this.runWrite(
      `
      MATCH (s:MemorySession {id: $sessionId})
      MERGE (o:GraphitiOutbox {id: $id})
      SET o += $payload
      MERGE (s)-[:HAS_GRAPHITI_OUTBOX]->(o)
      `,
      {
        sessionId: session.id,
        id: truncate(episode.id, 300),
        payload: {
          id: truncate(episode.id, 300),
          session_id: session.id,
          project: session.projectName || "unknown",
          kind: truncate(episode.kind, 80),
          name: truncate(episode.name, 300),
          body: truncate(episode.body, 50000),
          source_description: truncate(episode.sourceDescription, 300),
          status: "pending",
          attempts: 0,
          created_at: episode.at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_error: null,
        },
      },
    );
  }

  async claimGraphitiOutbox(limit = 5) {
    const result = await this.runWrite(
      `
      MATCH (o:GraphitiOutbox)
      WHERE coalesce(o.status, "pending") IN ["pending", "retry"]
        AND coalesce(o.next_attempt_at, "") <= $now
      WITH o
      ORDER BY o.created_at ASC
      LIMIT $limit
      SET o.status = "processing",
          o.updated_at = $now,
          o.attempts = coalesce(o.attempts, 0) + 1
      RETURN o
      `,
      {
        now: new Date().toISOString(),
        limit: this.neo4j.int(limit),
      },
    );
    return result.records.map((record) => record.get("o").properties);
  }

  async markGraphitiOutboxDone(id) {
    if (!id) return;
    await this.runWrite(
      `
      MATCH (o:GraphitiOutbox {id: $id})
      SET o.status = "done",
          o.done_at = $now,
          o.updated_at = $now,
          o.last_error = null
      `,
      { id, now: new Date().toISOString() },
    );
  }

  async markGraphitiOutboxFailed(id, errorMsg, retryAfterMs = 60000) {
    if (!id) return;
    const now = new Date();
    await this.runWrite(
      `
      MATCH (o:GraphitiOutbox {id: $id})
      SET o.status = CASE WHEN coalesce(o.attempts, 0) >= 5 THEN "failed" ELSE "retry" END,
          o.last_error = $error,
          o.next_attempt_at = $nextAttemptAt,
          o.updated_at = $now
      `,
      {
        id,
        error: truncate(errorMsg, 500),
        now: now.toISOString(),
        nextAttemptAt: new Date(now.getTime() + retryAfterMs).toISOString(),
      },
    );
  }

  async recordError(session, errorMsg) {
    if (!session?.id || !errorMsg) return;
    const at = new Date().toISOString();
    await this.recordMemoryOps(session, {}, [{
      id: `${session.id}:error:${Date.now()}`,
      op: "provider_error",
      target: "routing.provider",
      type: "error",
      confidence: "medium",
      status: "active",
      summary: truncate(errorMsg, 1000),
      at,
    }]);
  }

  async saveProjectContext(session, systemContent) {
    if (!session?.id || !systemContent) return;
    await this.recordSession(session);
    await this.runWrite(
      `
      MATCH (s:MemorySession {id: $sessionId})
      MERGE (c:ProjectContext {id: $contextId})
      SET c.project = $project,
          c.content = $content,
          c.updated_at = $at
      MERGE (s)-[:HAS_CONTEXT]->(c)
      `,
      {
        sessionId: session.id,
        contextId: `${session.id}:project-context`,
        project: session.projectName || "unknown",
        content: truncate(systemContent, 8000),
        at: new Date().toISOString(),
      },
    );
  }

  async recall(session, marker = {}, maxItems = 12) {
    if (!session?.id) return "";
    const tokens = normalizeTokens(marker.query || session.projectName || "");
    const project = session.projectName || "unknown";
    const result = await this.runRead(
      `
      MATCH (item)
      WHERE (item:MemoryEvent OR item:MemoryArchive OR item:ProjectContext)
        AND (
          ($project <> "unknown" AND item.project = $project)
          OR EXISTS {
            MATCH (:MemorySession {id: $sessionId})-[:HAS_MEMORY|HAS_ARCHIVE|HAS_CONTEXT]->(item)
          }
        )
      WITH item
      WHERE item IS NOT NULL
        AND coalesce(item.status, "active") <> "superseded"
      WITH item,
        toLower(
          coalesce(item.op, "") + " " +
          coalesce(item.target, "") + " " +
          coalesce(item.type, "") + " " +
          coalesce(item.summary, "") + " " +
          coalesce(item.title, "") + " " +
          coalesce(item.preview, "") + " " +
          coalesce(item.content, "")
        ) AS hay
      WHERE size($tokens) = 0 OR any(token IN $tokens WHERE hay CONTAINS token)
      RETURN labels(item) AS labels, item
      ORDER BY coalesce(item.at, item.updated_at, "") DESC
      LIMIT $limit
      `,
      {
        sessionId: session.id,
        project,
        tokens,
        limit: this.neo4j.int(maxItems),
      },
    );

    const lines = [];
    for (const record of result.records) {
      const labels = record.get("labels") || [];
      const item = record.get("item")?.properties || {};
      if (labels.includes("MemoryArchive")) {
        const excerpt = excerptForQuery(item.content, tokens);
        lines.push(`- archive ${item.uri || ""} ${item.title || ""}: ${item.summary || item.preview || ""}${excerpt ? ` | excerpt: ${excerpt}` : ""}`.trim());
      } else if (labels.includes("ProjectContext")) {
        const excerpt = excerptForQuery(item.content, tokens);
        lines.push(`- project_context ${item.project || ""}: ${excerpt}`);
      } else {
        const summary = item.summary ? `: ${item.summary}` : "";
        lines.push(`- ${item.status || "active"} ${item.op || "note"} ${item.type || "note"} ${item.target || "(untargeted)"} confidence=${item.confidence || "medium"}${summary}`);
      }
    }
    return lines.length ? ["Graph memory:", ...lines].join("\n") : "";
  }
}

module.exports = {
  Neo4jMemoryStore,
  renderArchiveContent,
  summarizeArchiveMessages,
};
