const test = require("node:test"),
  assert = require("node:assert/strict");
const { parseDocumentCatalog } = require("../lib/catalog-documents");
test("Codex credits retain their unit instead of becoming dollars", () => {
  const c = parseDocumentCatalog(
    "codex",
    "| Credits per 1M tokens | Input Tokens | Cached input tokens | Output Tokens |\n| --- | --- | --- | --- |\n| GPT-6 Astra | 250 credits | 25 credits | 1,250 credits |",
  );
  assert.equal(c.prices[0].currency, "credits");
  assert.equal(c.prices[0].inputPerMTok, null);
  assert.equal(c.prices[0].creditOutputPerMTok, 1250);
});
test("Codex official embedded HTML table retains credit values", () => {
  const c = parseDocumentCatalog(
    "codex",
    "<table><thead><tr><th>Credits per 1M tokens</th><th>Input Tokens</th><th>Cached input tokens</th><th>Output Tokens</th></tr></thead><tbody><tr><td>GPT-6 Astra</td><td>250 credits</td><td>25 credits</td><td>1,250 credits</td></tr></tbody></table>",
  );
  assert.equal(c.prices[0].creditInputPerMTok, 250);
});
test("OpenAI document parser reads the current short/long table with 30m and 12h cache writes", () => {
  const text = [
    "### Standard pricing data",
    "| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| gpt-fixture (<272K context length) | $2.00 | $10.00 | $0.20 | $2.50 | $5.00 | $4.00 | $15.00 | $0.40 | $5.00 | $10.00 |",
    "",
    "| Model | Input | Output | Cached input |",
    "| --- | --- | --- | --- |",
    "| gpt-fixture-mini | $0.75 | $4.50 | $0.075 |",
    "",
    "#### Flex",
    "| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| gpt-fixture | $1.00 | $5.00 | $0.10 | $1.25 | $2.50 | - | - | - | - | - |",
  ].join("\n");
  const r = parseDocumentCatalog("openai", text);
  const standard = r.prices.find(
    (p) => p.upstreamModel === "gpt-fixture" && p.serviceTier === "standard",
  );
  assert.equal(standard.inputPerMTok, 2);
  assert.equal(standard.outputPerMTok, 10);
  assert.equal(standard.cacheReadPerMTok, 0.2);
  assert.equal(standard.cacheWritePerMTok, 2.5);
  assert.equal(standard.cacheWrite12hPerMTok, 5);
  assert.equal(standard.contextTiers[1].inputPerMTok, 4);
  assert.equal(standard.contextTiers[1].cacheWrite12hPerMTok, 10);
  const mini = r.prices.find(
    (p) => p.upstreamModel === "gpt-fixture-mini" && p.serviceTier === "standard",
  );
  assert.equal(mini.inputPerMTok, 0.75);
  assert.equal(mini.cacheWritePerMTok, null);
  assert.equal(mini.contextTiers, undefined);
  const flex = r.prices.find((p) => p.serviceTier === "flex");
  assert.equal(flex.inputPerMTok, 1);
  assert.equal(flex.contextTiers, undefined);
});
test("OpenAI document parser separates Standard/Batch and long-context rates", () => {
  const text =
    "### Standard pricing data\n| Model | Short context input | Cached | Write | Output | Long input | Cached | Write | Output |\n| gpt-fixture | $2 | $0.2 | $2.5 | $10 | $4 | $0.4 | $5 | $15 |\n### Batch pricing data\n| gpt-fixture | $1 | $0.1 | $1.25 | $5 | $2 | $0.2 | $2.5 | $7.5 |";
  const r = parseDocumentCatalog("openai", text);
  assert.equal(r.prices[0].inputPerMTok, 2);
  assert.equal(r.prices[0].contextTiers[1].inputPerMTok, 4);
  assert.equal(r.prices[1].serviceTier, "batch");
});
test("Windsurf exported JSON is parsed without executing MDX and preserves plan identity", () => {
  const text =
    "export const modelCostData = " +
    JSON.stringify([
      {
        model_uid: "swe-fixture",
        label: "SWE fixture",
        tier: "TEAMS_TIER_PRO",
        input_cost_per_million_usd: 0,
        output_cost_per_million_usd: 0,
        credit_multiplier: 9,
      },
    ]) +
    ';\nthrow new Error("must not execute");';
  const r = parseDocumentCatalog("windsurf", text);
  assert.equal(r.prices[0].premiumMultiplier, 9);
  assert.equal(r.prices[0].conditions.plan, "TEAMS_TIER_PRO");
  assert.equal(r.models[0].id, "swe-fixture");
});
test("Mistral token and page prices are never conflated", () => {
  const r = parseDocumentCatalog(
    "mistral",
    "| Model | API name | Price |\n| Model | `fixture-chat` | Input $1 /M Tokens<br>Output $3 /M Tokens |\n| OCR | `fixture-ocr` | Input $4 /1000 Pages |",
  );
  assert.equal(r.prices[0].inputPerMTok, 1);
  assert.equal(r.prices[1].inputPerMTok, null);
  assert.equal(r.prices[1].unit, "non-token; see rawPricing");
});
