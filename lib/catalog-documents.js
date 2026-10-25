"use strict";
const SOURCES = {
  codex: "https://learn.chatgpt.com/docs/pricing.md",
  openai: "https://developers.openai.com/api/docs/pricing.md",
  claude: "https://platform.claude.com/docs/en/about-claude/pricing.md",
  windsurf: "https://docs.devin.ai/desktop/models.md",
  copilot:
    "https://docs.github.com/api/article/body?pathname=/en/copilot/reference/copilot-billing/models-and-pricing",
  mistral: "https://docs.mistral.ai/inference/pricing.md",
};
const money = (s) => {
  const m = String(s || "").match(/\$([\d.]+)/);
  return m ? Number(m[1]) : null;
};
const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((s) => s.trim());
function jsonArray(text, start) {
  let level = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "[") level++;
    else if (c === "]" && --level === 0)
      return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("Truncated exported JSON catalog");
}
function parseDocumentCatalog(
  providerId,
  text,
  { observedAt = new Date().toISOString(), source = SOURCES[providerId] } = {},
) {
  const prices = [],
    models = [];
  const base = {
    providerId,
    billingBasis: "api",
    serviceTier: "standard",
    currency: "USD",
    cacheReadPerMTok: null,
    cacheWritePerMTok: null,
    observedAt,
    source,
    unit: "USD per 1M tokens",
  };
  const add = (id, price, label = id) => {
    prices.push({ ...base, upstreamModel: id, ...price });
    models.push({
      providerId,
      id,
      upstreamModel: id,
      displayName: label,
      source,
      observedAt,
      availability: "public",
      capabilities: [],
      contextWindow: null,
    });
  };
  if (providerId === "windsurf") {
    const families = new Map(),
      modelFamilies = new Map();
    const familyBlock =
      text.match(/const longContextFamilies = \{([\s\S]*?)\n  \};/)?.[1] || "";
    for (const match of familyBlock.matchAll(/'([^']+)':\s*\{([^}]+)\}/g)) {
      const props = Object.fromEntries(
        [...match[2].matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]),
      );
      const threshold = Number(props.threshold?.replace(/K$/, "")) * 1000;
      if (Number.isFinite(threshold))
        families.set(match[1], {
          threshold,
          inputPerMTok: money(props.input),
          outputPerMTok: money(props.output),
          cacheReadPerMTok: money(props.cacheInput),
          cacheWritePerMTok: money(props.cacheWrite),
        });
    }
    const mappingBlock =
      text.match(/const longContextModelFamilies = \{([\s\S]*?)\n  \};/)?.[1] ||
      "";
    for (const match of mappingBlock.matchAll(
      /(?:'([^']+)'|(\w+)):\s*'([^']+)'/g,
    ))
      modelFamilies.set(match[1] || match[2], match[3]);
    const marker = "export const modelCostData = ";
    const start = text.indexOf(marker);
    if (start < 0) throw new Error("Windsurf modelCostData missing");
    for (const m of jsonArray(text, text.indexOf("[", start + marker.length))) {
      const promo = m.tier === "TEAMS_TIER_PRO" && /^swe-2/.test(m.model_uid);
      add(
        m.model_uid,
        {
          billingBasis: "subscription",
          serviceTier: /priority|fast mode/i.test(m.model_uid + " " + m.label)
            ? "fast"
            : "standard",
          inputPerMTok: m.input_cost_per_million_usd ?? null,
          outputPerMTok: m.output_cost_per_million_usd ?? null,
          cacheReadPerMTok: m.cache_read_cost_per_million_usd ?? null,
          cacheWritePerMTok: m.cache_write_cost_per_million_usd ?? null,
          premiumMultiplier: m.credit_multiplier ?? null,
          conditions: {
            plan: m.tier,
            referenceRates: true,
            ...(promo
              ? {
                  promotionEndDate: "2026-10-15",
                  timezone: "not specified; confirm model selector",
                }
              : {}),
          },
          ...(promo ? { validUntil: "2026-10-16T00:00:00Z" } : {}),
        },
        m.label,
      );
      const long = families.get(modelFamilies.get(m.model_uid));
      if (long) {
        const { threshold, ...rates } = long;
        const short = prices.at(-1);
        short.longContextThreshold = threshold;
        short.contextTiers = [
          {
            maxInputTokens: threshold,
            inputPerMTok: short.inputPerMTok,
            outputPerMTok: short.outputPerMTok,
            cacheReadPerMTok: short.cacheReadPerMTok,
            cacheWritePerMTok: short.cacheWritePerMTok,
          },
          { minInputTokens: threshold + 1, ...rates },
        ];
      }
    }
  } else if (providerId === "openai") {
    // The pricing document mixes service tiers as ###/#### headings and two
    // table shapes: an 11-column short/long-context table (with 30m and 12h
    // cache-write rates) and a 4-column input/output/cached table. The older
    // 9-column short/long table is kept for archived snapshots.
    let tier = null;
    for (const line of text.split(/\r?\n/)) {
      const heading = line.match(/^#{3,4}\s+(.*)$/);
      if (heading) {
        tier =
          heading[1].match(
            /^(Standard|Batch|Flex|Fast|Ultrafast)(?:\s+pricing data)?$/i,
          )?.[1]?.toLowerCase() || null;
        continue;
      }
      if (!tier || !line.trim().startsWith("|")) continue;
      const c = cells(line);
      if (money(c[1]) === null) continue;
      const id = c[0].replace(/\s*\(.*$/, "");
      let short, long, cacheWrite12h;
      if (c.length === 11) {
        const rate = (input, output, cached, write30m, write12h) => ({
          inputPerMTok: money(input),
          outputPerMTok: money(output),
          cacheReadPerMTok: money(cached),
          cacheWritePerMTok: money(write30m),
          cacheWrite12hPerMTok: money(write12h),
        });
        short = rate(c[1], c[2], c[3], c[4], c[5]);
        long = rate(c[6], c[7], c[8], c[9], c[10]);
        cacheWrite12h = short.cacheWrite12hPerMTok;
      } else if (c.length === 4) {
        short = {
          inputPerMTok: money(c[1]),
          outputPerMTok: money(c[2]),
          cacheReadPerMTok: money(c[3]),
          cacheWritePerMTok: null,
        };
        long = { ...short };
        long.inputPerMTok = null;
      } else if (c.length === 9) {
        short = {
          inputPerMTok: money(c[1]),
          cacheReadPerMTok: money(c[2]),
          cacheWritePerMTok: money(c[3]),
          outputPerMTok: money(c[4]),
        };
        long = {
          inputPerMTok: money(c[5]),
          cacheReadPerMTok: money(c[6]),
          cacheWritePerMTok: money(c[7]),
          outputPerMTok: money(c[8]),
        };
      } else continue;
      add(id, {
        ...short,
        serviceTier: tier,
        ...(cacheWrite12h !== undefined
          ? { cacheWrite12hPerMTok: cacheWrite12h }
          : {}),
        ...(long.inputPerMTok !== null
          ? {
              contextTiers: [
                { ...short, maxInputTokens: 272000 },
                { ...long, minInputTokens: 272001 },
              ],
              longContextThreshold: 272000,
            }
          : {}),
      });
    }
  } else if (providerId === "claude") {
    let active = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("| Model") && line.includes("Base input tokens")) {
        active = true;
        continue;
      }
      if (active && /^## /.test(line)) break;
      if (!active || !line.startsWith("|")) continue;
      const c = cells(line);
      const label = c[0]?.match(/^Claude ([A-Za-z]+) (\d+(?:\.\d+)?)/);
      if (!label || c.length !== 6) continue;
      const current = [
        "Fable 5.1",
        "Opus 5.5",
        "Sonnet 5.5",
        "Haiku 5.5",
      ].includes(label[1] + " " + label[2]);
      const id = current
        ? "claude-" +
          label[1].toLowerCase() +
          "-" +
          label[2].replace(/\./g, "-")
        : "display:Claude " + label[1] + " " + label[2];
      const price = {
        inputPerMTok: money(c[1]),
        cacheWritePerMTok: money(c[2]),
        cacheWrite1hPerMTok: money(c[3]),
        cacheReadPerMTok: money(c[4]),
        outputPerMTok: money(c[5]),
      };
      if (c[0].includes("retired"))
        price.conditions = {
          lifecycle:
            "Retired on direct API; cloud-provider rates require separate provider identity",
        };
      if (/Haiku 5\.5/.test(c[0]))
        price.conditions = {
          ...(price.conditions || {}),
          ...(/over 100,000/.test(c[0])
            ? { minInputTokens: 100001 }
            : { maxInputTokens: 100000 }),
        };
      add(id, price, "Claude " + label[1] + " " + label[2]);
      if (!current) {
        prices.at(-1).identityStatus = "display-label-only";
        models.at(-1).identityStatus = "display-label-only";
      }
    }
  } else if (providerId === "mistral") {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("|")) continue;
      const c = cells(line);
      const id = c[1]?.match(/`([^`]+)`/)?.[1];
      if (!id) continue;
      const input = c[2].match(/(?:^|<br>)Input \$([\d.]+) \/M Tokens/),
        output = c[2].match(/(?:^|<br>)Output \$([\d.]+) \/M Tokens/),
        cache = c[2].match(/Cached input \$([\d.]+) \/M Tokens/);
      add(id, {
        inputPerMTok: input ? Number(input[1]) : null,
        outputPerMTok: output ? Number(output[1]) : null,
        cacheReadPerMTok: cache ? Number(cache[1]) : null,
        unit:
          input || output ? "USD per 1M tokens" : "non-token; see rawPricing",
        rawPricing: c[2],
        conditions: /sale price/.test(c[2])
          ? {
              promotion: "Expiry not published; reconfirm before applying",
              regularRates: c[2].match(/regular \$[\d.]+/g),
            }
          : null,
      });
    }
  } else if (providerId === "codex") {
    text = text.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => {
      if (!table.includes("Credits per 1M tokens")) return "";
      return (
        "\n" +
        [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
          .map((row) => {
            const c = [
              ...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi),
            ].map((m) =>
              m[1]
                .replace(/<[^>]*>/g, "")
                .replace(/\s+/g, " ")
                .trim(),
            );
            return c.length === 4 ? "| " + c.join(" | ") + " |" : "";
          })
          .filter(Boolean)
          .join("\n") +
        "\n\n"
      );
    });
    let active = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("| Credits per 1M tokens")) {
        active = true;
        continue;
      }
      if (active && !line.startsWith("|") && prices.length) break;
      if (!active || !line.startsWith("|")) continue;
      const c = cells(line);
      if (c.length !== 4 || !c[1].includes("credits")) continue;
      const credits = (s) => {
        const m = s.replace(/,/g, "").match(/([\d.]+) credits/);
        return m ? Number(m[1]) : null;
      };
      add(
        "display:" + c[0],
        {
          billingBasis: "credits",
          currency: "credits",
          unit: "credits per 1M tokens",
          identityStatus: "display-label-only",
          inputPerMTok: null,
          outputPerMTok: null,
          creditInputPerMTok: credits(c[1]),
          creditCacheReadPerMTok: credits(c[2]),
          creditOutputPerMTok: credits(c[3]),
          conditions: {
            billing:
              "Purchased credits and Enterprise pay-as-you-go; included subscription limits differ",
            cacheWrite: "No separate credit charge",
            fastMultiplier: 2,
            ultrafastMultiplier: 6,
            speedAvailability: "Verify eligible model and plan",
          },
        },
        c[0],
      );
    }
  } else if (providerId === "copilot") {
    let header = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("|")) continue;
      const c = cells(line);
      if (c[0] === "Model") {
        header = c;
        continue;
      }
      if (
        !header.includes("Input") ||
        !c[0] ||
        money(c[header.indexOf("Input")]) === null
      )
        continue;
      const label = c[0]
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]*>/g, "")
        .trim();
      if (!label) continue;
      const threshold = c[header.indexOf("Threshold (input tokens)")] || "";
      add(
        "display:" + label,
        {
          billingBasis: "credits",
          modelLabel: label,
          identityStatus: "display-label-only",
          inputPerMTok: money(c[header.indexOf("Input")]),
          outputPerMTok: money(c[header.indexOf("Output")]),
          cacheReadPerMTok: money(c[header.indexOf("Cached input")]),
          cacheWritePerMTok: header.includes("Cache write")
            ? money(c[header.indexOf("Cache write")])
            : null,
          conditions: {
            billing: "AI credits; 1 credit = USD0.01",
            plan: "usage-based plans; legacy annual multipliers differ",
            context: threshold || null,
            tier: c[header.indexOf("Tier")] || null,
          },
        },
        label,
      );
    }
  }
  if (!models.length) throw new Error("No recognized official catalog rows");
  return {
    models: [...new Map(models.map((m) => [m.id, m])).values()],
    prices,
  };
}
module.exports = { parseDocumentCatalog, SOURCES };
