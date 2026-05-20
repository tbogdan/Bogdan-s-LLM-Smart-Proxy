"use strict";

const COMMANDS = [
  { method: "GET", path: "/", href: "/", description: "Small HTML landing page with links to health, models, and commands." },
  { method: "GET", path: "/commands", href: "/commands", description: "HTML list of available proxy commands and endpoint descriptions." },
  { method: "GET", path: "/health", href: "/health", description: "Runtime health, provider counts, smart groups, and backing data files." },
  { method: "GET", path: "/v1/models", href: "/v1/models", description: "OpenAI-compatible model list, including smart groups and discovered models." },
  { method: "GET", path: "/v1/capabilities", href: "/v1/capabilities", description: "Capability summary grouped by provider and smart routing group." },
  { method: "GET", path: "/scores", href: "/scores", description: "Provider reliability, latency, cooldown, and routing policy score state." },
  { method: "GET", path: "/discovery", href: "/discovery", description: "Last model discovery results for Windsurf, Claude, and Codex." },
  { method: "GET", path: "/stats", href: "/stats", description: "Session token usage and provider/model usage aggregation." },
  { method: "POST", path: "/v1/chat/completions", description: "OpenAI-compatible chat completions endpoint with smart routing and failover." },
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
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 980px; margin: 0 auto; padding: 40px 22px; }
    h1 { font-size: 28px; margin: 0 0 10px; letter-spacing: 0; }
    h2 { font-size: 18px; margin: 28px 0 10px; letter-spacing: 0; }
    p { line-height: 1.55; margin: 8px 0; }
    a { color: LinkText; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    .muted { opacity: 0.74; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; margin-top: 18px; }
    .tile { border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 8px; padding: 14px; }
    .tile strong { display: block; margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); vertical-align: top; }
    th { font-size: 12px; text-transform: uppercase; opacity: 0.68; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
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
  return page("Project LLM Smart Proxy", `    <h1>Project LLM Smart Proxy</h1>
    <p class="muted">Local Docker smart proxy for Windsurf, Claude, and Codex.</p>
    <p><strong>${escapeHtml(activeProviders)} / ${escapeHtml(totalProviders)} active providers</strong></p>
    <div class="grid">
      <div class="tile"><strong><a href="/commands">Available commands</a></strong><span class="muted">All HTTP and WebSocket endpoints with short descriptions.</span></div>
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

module.exports = {
  COMMANDS,
  renderHomePage,
  renderCommandsPage,
};
