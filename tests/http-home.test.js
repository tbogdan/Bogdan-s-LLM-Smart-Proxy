"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const home = require("../lib/http-home");

test("renderHomePage links to available commands and core endpoints", () => {
  const html = home.renderHomePage({ activeProviders: 89, totalProviders: 100, groups: ["auto", "auto-coding"] });

  assert.match(html, /Project LLM Smart Proxy/);
  assert.match(html, /class="shell"/);
  assert.match(html, /href="\/commands"/);
  assert.match(html, /Available commands/);
  assert.match(html, /href="\/health"/);
  assert.match(html, /href="\/v1\/models"/);
  assert.match(html, /href="\/benchmark"/);
  assert.match(html, /89 \/ 100 active providers/);
});

test("renderCommandsPage lists methods, paths, and short descriptions", () => {
  const html = home.renderCommandsPage();

  assert.match(html, /<td>GET<\/td>\s*<td><a href="\/health">\/health<\/a><\/td>/);
  assert.match(html, /<td>POST<\/td>\s*<td><code>\/v1\/chat\/completions<\/code><\/td>/);
  assert.match(html, /OpenAI-compatible chat completions/);
  assert.match(html, /Anthropic Messages bridge/);
  assert.match(html, /\/discovery\?refresh=1/);
  assert.match(html, /Force-refresh discovery metadata from loaded providers/);
});

test("renderBenchmarkPage documents safe benchmark command and metrics", () => {
  const html = home.renderBenchmarkPage();

  assert.match(html, /Proxy benchmark/);
  assert.match(html, /npm run benchmark -- --run/);
  assert.match(html, /max-cases=6/);
  assert.match(html, /suite=opus/);
  assert.match(html, /suite=all/);
  assert.match(html, /max-minutes=5/);
  assert.doesNotMatch(html, /budget-usd/);
  assert.match(html, /runtime by default/);
  assert.match(html, /Latency/);
  assert.match(html, /Correctness/);
  assert.match(html, /proxy savings percentage/);
  assert.match(html, /ASCII/);
});
