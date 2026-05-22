"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SemanticMemorySidecar, archiveEpisode, memoryEventEpisode } = require("../lib/memory/semantic-sidecar");
const { Neo4jMemoryStore } = require("../lib/memory/neo4j-store");

test("SemanticMemorySidecar maps memory ops into Graphiti episodes", async () => {
  const episodes = [];
  const ledger = { enqueueGraphitiOutbox: async (_session, episode) => episodes.push(episode) };
  const sidecar = new SemanticMemorySidecar({ GRAPHITI_MCP_ENABLED: "true" }, { ledger });

  await sidecar.enqueueMemoryEvents({ id: "s1", projectName: "llm-proxy" }, [{
    id: "e1",
    op: "user_correction",
    type: "decision",
    target: "architecture.memory",
    confidence: "high",
    status: "supersedes",
    summary: "Proxy memory stays canonical.",
    at: "2026-05-22T00:00:00.000Z",
  }]);

  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].id, "memory-event:e1");
  assert.equal(episodes[0].kind, "memory_event");
  assert.match(episodes[0].body, /user_correction/);
  assert.match(episodes[0].body, /Proxy memory stays canonical/);
});

test("SemanticMemorySidecar maps compacted archives into Graphiti episodes", () => {
  const episode = archiveEpisode({ projectName: "llm-proxy" }, {
    uri: "memory://episode/s1-1",
    title: "llm-proxy compacted context",
    summary: "2 non-system messages archived",
    content: "Important context from compacted transcript.",
  });

  assert.equal(episode.id, "memory-archive:memory://episode/s1-1");
  assert.equal(episode.kind, "memory_archive");
  assert.match(episode.body, /Important context/);
  assert.equal(episode.sourceDescription, "llm-proxy compacted context archive");
});

test("SemanticMemorySidecar can warm up the Graphiti client", async () => {
  let initialized = false;
  const client = {
    ensureInitialized: async () => { initialized = true; },
    health: () => ({ available: initialized, initialized }),
  };
  const sidecar = new SemanticMemorySidecar({ GRAPHITI_MCP_ENABLED: "true" }, { client });

  await sidecar.initialize();

  assert.equal(initialized, true);
  assert.equal(sidecar.health().client.available, true);
});

test("SemanticMemorySidecar retries warmup while Graphiti is starting", async () => {
  let attempts = 0;
  let initialized = false;
  const client = {
    ensureInitialized: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("booting");
      initialized = true;
    },
    health: () => ({ available: initialized, initialized }),
  };
  const sidecar = new SemanticMemorySidecar({
    GRAPHITI_MCP_ENABLED: "true",
    GRAPHITI_MCP_WARMUP_RETRIES: "1",
    GRAPHITI_MCP_WARMUP_RETRY_MS: "1",
  }, { client });

  await sidecar.initialize();

  assert.equal(attempts, 2);
  assert.equal(initialized, true);
});

test("SemanticMemorySidecar health retries a previously unavailable Graphiti client", async () => {
  let initialized = false;
  const client = {
    ensureInitialized: async () => { initialized = true; },
    health: () => ({ available: initialized, initialized }),
  };
  const sidecar = new SemanticMemorySidecar({
    GRAPHITI_MCP_ENABLED: "true",
    GRAPHITI_MCP_WARMUP_RETRIES: "0",
  }, { client });

  assert.equal(sidecar.health().client.available, false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sidecar.health().client.available, true);
});

test("SemanticMemorySidecar drains outbox without throwing on Graphiti failure", async () => {
  const marked = [];
  const ledger = {
    claimGraphitiOutbox: async () => [{ id: "o1", project: "llm-proxy", name: "n", body: "b", source_description: "s" }],
    markGraphitiOutboxDone: async (id) => marked.push(["done", id]),
    markGraphitiOutboxFailed: async (id) => marked.push(["failed", id]),
  };
  const client = { addEpisode: async () => { throw new Error("down"); }, health: () => ({ available: false }) };
  const sidecar = new SemanticMemorySidecar({ GRAPHITI_MCP_ENABLED: "true" }, { ledger, client });

  await sidecar.drainOnce();

  assert.deepEqual(marked, [["failed", "o1"]]);
});

test("SemanticMemorySidecar drains items enqueued while a drain is active", async () => {
  const queue = [{
    id: "memory-event:e1",
    project: "llm-proxy",
    name: "first",
    body: "first",
    source_description: "test",
    status: "pending",
  }];
  const marked = [];
  let sidecar;
  const ledger = {
    enqueueGraphitiOutbox: async (_session, episode) => {
      queue.push({
        id: episode.id,
        project: "llm-proxy",
        name: episode.name,
        body: episode.body,
        source_description: episode.sourceDescription,
        status: "pending",
      });
    },
    claimGraphitiOutbox: async () => {
      const claimed = queue.filter((item) => item.status === "pending");
      for (const item of claimed) item.status = "processing";
      return claimed;
    },
    markGraphitiOutboxDone: async (id) => {
      marked.push(id);
      const item = queue.find((entry) => entry.id === id);
      if (item) item.status = "done";
    },
    markGraphitiOutboxFailed: async () => {},
  };
  const client = {
    addEpisode: async (episode) => {
      if (episode.id === "memory-event:e1") {
        await sidecar.enqueueMemoryEvents({ id: "s1", projectName: "llm-proxy" }, [{
          id: "e2",
          op: "save_fact",
          target: "memory.outbox",
          summary: "second",
        }]);
      }
    },
    health: () => ({ available: true }),
  };
  sidecar = new SemanticMemorySidecar({ GRAPHITI_MCP_ENABLED: "true" }, { ledger, client });

  await sidecar.drainOnce();

  assert.deepEqual(marked, ["memory-event:e1", "memory-event:e2"]);
  assert.equal(queue.every((item) => item.status === "done"), true);
});

test("SemanticMemorySidecar formats semantic search as memory hints", async () => {
  const client = { search: async () => ["Fact: project recall uses project name."], health: () => ({ available: true }) };
  const sidecar = new SemanticMemorySidecar({ GRAPHITI_MCP_ENABLED: "true" }, { client });

  const text = await sidecar.search({ projectName: "llm-proxy" }, { query: "recall", budget: 800 });

  assert.match(text, /Semantic graph memory/);
  assert.match(text, /project recall uses project name/);
});

test("memoryEventEpisode preserves correction status and target", () => {
  const episode = memoryEventEpisode({ projectName: "llm-proxy" }, {
    id: "correction-1",
    op: "user_correction",
    target: "architecture.graphiti",
    status: "supersedes",
    summary: "Graphiti is a sidecar.",
  });

  assert.match(episode.name, /user_correction/);
  assert.match(episode.body, /status: supersedes/);
  assert.match(episode.body, /architecture\.graphiti/);
});

test("Neo4jMemoryStore enqueues and claims Graphiti outbox items", async () => {
  const store = new Neo4jMemoryStore({});
  const writes = [];
  store.neo4j = { int: (value) => value };
  store.recordSession = async () => {};
  store.runWrite = async (query, params) => {
    writes.push({ query, params });
    if (/RETURN o/.test(query)) {
      return { records: [{ get: () => ({ properties: { id: "o1", body: "queued" } }) }] };
    }
    return { records: [] };
  };

  await store.enqueueGraphitiOutbox({ id: "s1", projectName: "llm-proxy" }, {
    id: "o1",
    kind: "memory_event",
    name: "memory",
    body: "queued",
    sourceDescription: "test",
  });
  const claimed = await store.claimGraphitiOutbox(3);

  assert.match(writes[0].query, /GraphitiOutbox/);
  assert.equal(writes[0].params.payload.status, "pending");
  assert.match(writes[1].query, /LIMIT \$limit/);
  assert.equal(writes[1].params.limit, 3);
  assert.deepEqual(claimed, [{ id: "o1", body: "queued" }]);
});
