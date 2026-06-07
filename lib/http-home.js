"use strict";

const COMMANDS = [
  { method: "GET", path: "/", href: "/", description: "Operational HTML dashboard with proxy status, links, and routing surfaces." },
  { method: "GET", path: "/commands", href: "/commands", description: "HTML list of available proxy commands and endpoint descriptions." },
  { method: "GET", path: "/benchmark", href: "/benchmark", description: "Benchmark guide for A/B testing direct model calls against optimized proxy routing." },
  { method: "GET", path: "/health", href: "/health", description: "Runtime health, provider counts, smart groups, and backing data files." },
  { method: "GET", path: "/v1/models", href: "/v1/models", description: "OpenAI-compatible model list, including smart groups and discovered models." },
  { method: "GET", path: "/v1/capabilities", href: "/v1/capabilities", description: "Capability summary grouped by provider and smart routing group." },
  { method: "GET", path: "/scores", href: "/scores", description: "Provider reliability, latency, cooldown, and routing policy score state." },
  { method: "GET", path: "/discovery", href: "/discovery", description: "Last model discovery results for Windsurf, Claude, Codex, and Copilot." },
  { method: "GET", path: "/discovery?refresh=1", href: "/discovery?refresh=1", description: "Force-refresh discovery metadata from loaded providers." },
  { method: "GET", path: "/stats", href: "/stats", description: "Session token usage and provider/model usage aggregation." },
  { method: "POST", path: "/v1/chat/completions", description: "OpenAI-compatible chat completions endpoint with smart routing and failover." },
  { method: "POST", path: "/v1/embeddings", description: "OpenAI-compatible local embedding endpoint for memory sidecars." },
  { method: "POST", path: "/v1/responses", description: "OpenAI Responses API bridge for Codex-style clients." },
  { method: "WS", path: "/v1/responses", description: "WebSocket Responses API bridge." },
  { method: "POST", path: "/v1/messages", description: "Anthropic Messages bridge for Claude Code and Anthropic-compatible clients." },
  { method: "POST", path: "/v1/messages/count_tokens", description: "Anthropic-compatible token counting endpoint." },
];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function linkOrCode(command) {
  const path = escapeHtml(command.path);
  if (command.href) return `<a href="${escapeHtml(command.href)}">${path}</a>`;
  return `<code>${path}</code>`;
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --line: color-mix(in srgb, CanvasText 15%, Canvas); --soft: color-mix(in srgb, CanvasText 4%, Canvas); --panel: color-mix(in srgb, CanvasText 2%, Canvas); --accent: #0f766e; --warn: #b45309; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 1120px; margin: 0 auto; padding: 30px 22px 48px; }
    h1 { font-size: 30px; line-height: 1.1; margin: 0; letter-spacing: 0; }
    h2 { font-size: 18px; margin: 30px 0 10px; letter-spacing: 0; }
    h3 { font-size: 14px; margin: 0 0 8px; letter-spacing: 0; }
    p { line-height: 1.55; margin: 8px 0; }
    a { color: LinkText; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    .muted { opacity: 0.72; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
    .nav { display: flex; flex-wrap: wrap; gap: 8px; }
    .nav a, .pill { display: inline-flex; align-items: center; min-height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); text-decoration: none; color: CanvasText; font-size: 13px; }
    .hero { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(260px, 0.8fr); gap: 24px; align-items: stretch; padding: 28px 0 6px; }
    .lede { max-width: 680px; font-size: 16px; }
    .status { border-left: 4px solid var(--accent); padding: 14px 0 14px 18px; background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 8%, Canvas), transparent); }
    .status strong { display: block; font-size: 22px; line-height: 1.1; margin-bottom: 6px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 18px; }
    .tile { border: 1px solid var(--line); border-radius: 8px; padding: 15px; background: var(--panel); min-height: 94px; }
    .tile strong { display: block; margin-bottom: 6px; }
    .tile a { font-weight: 700; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 0.72fr); gap: 18px; align-items: start; }
    .panel { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 16px; }
    .shell { display: block; white-space: pre-wrap; overflow-x: auto; padding: 14px; border-radius: 8px; border: 1px solid var(--line); background: #101418; color: #e7edf3; line-height: 1.45; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 12px; }
    .metric { padding: 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--soft); }
    .metric b { display: block; font-size: 13px; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { font-size: 12px; text-transform: uppercase; opacity: 0.68; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
    @media (max-width: 760px) { main { padding: 24px 16px 38px; } .topbar, .hero, .split { display: block; } .nav { margin-top: 16px; } .status { margin-top: 18px; } }
  </style>
</head>
<body>
  <main>
${body}
  </main>
</body>
</html>`;
}

function renderHomePage({ activeProviders = 0, totalProviders = 0, groups = [] } = {}) {
  return page("LLM Proxy LLM Smart Proxy", `    <div class="topbar">
      <div>
        <h1>LLM Proxy LLM Smart Proxy</h1>
        <p class="muted">Local Docker smart proxy for Windsurf, Claude, Codex, and Copilot.</p>
      </div>
      <nav class="nav" aria-label="Primary">
        <a href="/commands">Commands</a>
        <a href="/benchmark">Benchmark</a>
        <a href="/health">Health</a>
        <a href="/v1/models">Models</a>
      </nav>
    </div>
    <section class="hero">
      <div>
        <p class="lede">Smart routing chooses a concrete model per request, tracks provider health, and exposes OpenAI and Anthropic-compatible endpoints for local IDE use.</p>
        <pre class="shell">curl http://localhost:18900/health
curl http://localhost:18900/v1/models
npm run benchmark -- --run --suite=all --max-minutes=5</pre>
      </div>
      <aside class="status">
        <strong>${escapeHtml(activeProviders)} / ${escapeHtml(totalProviders)} active providers</strong>
        <span class="muted">Discovery, scoring, cooldown, and compatibility state are loaded from the local data volume.</span>
      </aside>
    </section>
    <div class="grid">
      <div class="tile"><strong><a href="/commands">Available commands</a></strong><span class="muted">All HTTP and WebSocket endpoints with short descriptions.</span></div>
      <div class="tile"><strong><a href="/benchmark">Proxy benchmark</a></strong><span class="muted">A/B compare direct model calls with optimized proxy routing.</span></div>
      <div class="tile"><strong><a href="/health">Health</a></strong><span class="muted">Runtime status and provider availability.</span></div>
      <div class="tile"><strong><a href="/v1/models">Models</a></strong><span class="muted">Smart groups and discovered model IDs.</span></div>
      <div class="tile"><strong><a href="/stats">Stats</a></strong><span class="muted">Session token usage by provider and model.</span></div>
    </div>
    <h2>Smart Groups</h2>
    <p>${groups.length ? groups.map((group) => `<code>${escapeHtml(group)}</code>`).join(" ") : "<span class=\"muted\">No groups loaded yet.</span>"}</p>`);
}

function renderCommandsPage() {
  const rows = COMMANDS.map((command) => `      <tr><td>${escapeHtml(command.method)}</td><td>${linkOrCode(command)}</td><td>${escapeHtml(command.description)}</td></tr>`).join("\n");
  return page("Available commands", `    <h1>Available commands</h1>
    <p class="muted">HTTP and WebSocket surfaces exposed by the local proxy.</p>
    <p><a href="/">Back to proxy home</a></p>
    <table>
      <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>`);
}

function renderBenchmarkPage() {
  return page("Proxy benchmark", `    <div class="topbar">
      <div>
        <h1>Proxy benchmark</h1>
        <p class="muted">A small A/B harness for direct model calls versus an optimized smart-routing ladder.</p>
      </div>
      <nav class="nav" aria-label="Benchmark navigation">
        <a href="/">Home</a>
        <a href="/commands">Commands</a>
        <a href="/stats">Stats</a>
      </nav>
    </div>
    <section class="split">
      <div>
        <h2>Safe default</h2>
        <p>The benchmark is a dry run until <code>--run</code> is supplied. The direct arm bypasses proxy prompt injection and compaction, while the proxy arm keeps full optimization enabled and moves across smart groups per task. The suite is coding-heavy, with code reasoning, repair, secure coding, tool-use, terminal-agent recovery, and architecture cases. Runs are bounded by runtime by default, not by a cost cap.</p>
        <pre class="shell">npm run benchmark
npm run benchmark -- --run --max-cases=6
npm run benchmark -- --run --suite=opus
npm run benchmark -- --run --suite=all --max-minutes=5
npm run benchmark -- --run --direct-model=windsurf/claude-opus-4.6 --proxy-model=auto-coding</pre>
      </div>
      <aside class="panel">
        <h2>Metrics</h2>
        <div class="metrics">
          <div class="metric"><b>Latency</b><span class="muted">Wall clock per request.</span></div>
          <div class="metric"><b>Correctness</b><span class="muted">Case graders and weighted score.</span></div>
          <div class="metric"><b>Tokens</b><span class="muted">Prompt, completion, and total.</span></div>
          <div class="metric"><b>Cost</b><span class="muted">Estimated USD, cost group, and proxy savings percentage.</span></div>
          <div class="metric"><b>Provider mix</b><span class="muted">Direct provider and proxy-selected providers.</span></div>
          <div class="metric"><b>ASCII charts</b><span class="muted">Terminal-friendly comparison bars.</span></div>
        </div>
      </aside>
    </section>
    <h2>Research basis</h2>
    <p class="muted">The harness follows the same spirit as holistic evaluation: compare the same scenarios across systems and report multiple metrics, not only correctness.</p>`);
}

module.exports = {
  COMMANDS,
  renderHomePage,
  renderCommandsPage,
  renderBenchmarkPage,
};
