# Provider coverage — 2026-10-24

Official public evidence and read-only account model-list status. Published counts include scoped price variants; display-only labels are not route IDs. A listed model is not an inference success.

| Provider | Public model identities | Token price observations | Price status | Account listing | Official pricing |
|---|---:|---:|---|---|---|
| windsurf | 296 | 572 | published_scoped_rates | missing_credentials | [source](https://docs.devin.ai/desktop/models) |
| claude | 20 | 21 | published_scoped_rates | http_401 | [source](https://platform.claude.com/docs/en/about-claude/pricing) |
| codex | 21 | 0 | credits_or_multiplier | listed | [source](https://learn.chatgpt.com/docs/pricing) |
| copilot | 33 | 46 | published_scoped_rates | listing_unavailable | [source](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) |
| groq | 12 | 4 | published_scoped_rates | listed | [source](https://console.groq.com/docs/models) |
| openrouter | 476 | 469 | published_scoped_rates | listed | [source](https://openrouter.ai/models) |
| openai | 42 | 124 | published_scoped_rates | missing_credentials | [source](https://developers.openai.com/api/docs/pricing) |
| mistral | 57 | 12 | published_scoped_rates | listed | [source](https://docs.mistral.ai/inference/pricing) |
| cerebras | 2 | 2 | published_scoped_rates | listed | [source](https://www.cerebras.ai/pricing) |
| sambanova | 7 | 7 | published_scoped_rates | listed | [source](https://cloud.sambanova.ai/plans/pricing) |
| nvidia | 86 | 0 | unknown_or_non_token | listed | [source](https://docs.api.nvidia.com/nim/docs/product) |
| gemini | 63 | 14 | published_scoped_rates | listed | [source](https://ai.google.dev/gemini-api/docs/pricing) |
| llm7 | 71 | 106 | published_scoped_rates | listed | [source](https://llm7.io/pricing) |
| ovh | 18 | 15 | published_scoped_rates | missing_credentials | [source](https://www.ovhcloud.com/en/public-cloud/prices/) |
| cloudflare | 69 | 41 | published_scoped_rates | account_id_required | [source](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| siliconflow | 81 | 32 | published_scoped_rates | listed | [source](https://www.siliconflow.com/pricing) |
| bigmodel | 11 | 3 | published_scoped_rates | listed | [source](https://open.bigmodel.cn/pricing) |
| deepseek | 2 | 6 | published_scoped_rates | listed | [source](https://api-docs.deepseek.com/quick_start/pricing/) |
| alibaba | 102 | 19 | published_scoped_rates | listed | [source](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
| cohere | 8 | 7 | published_scoped_rates | missing_credentials | [source](https://cohere.com/pricing) |
| ollama | 27 | 22 | published_scoped_rates | listed | [source](https://ollama.com/pricing) |
| huggingface | 448 | 388 | published_scoped_rates | listed | [source](https://huggingface.co/docs/inference-providers/pricing) |
| kiro | 22 | 0 | credits_or_multiplier | missing_credentials | [source](https://kiro.dev/pricing/) |
| cline | 481 | 0 | unknown_or_non_token | listed | [source](https://docs.cline.bot/core-features/model-selection-guide) |
| modelscope | 36 | 0 | unknown_or_non_token | listed | [source](https://www.modelscope.cn/docs/model-service/API-Inference/intro) |
| githubmodels | 0 | 0 | unknown_or_non_token | retired | [source](https://docs.github.com/en/github-models) |
| kilo | 409 | 399 | published_scoped_rates | listed | [source](https://kilo.ai/docs/gateway/models-and-providers) |
| kimi | 6 | 9 | published_scoped_rates | listed | [source](https://platform.kimi.ai/docs/pricing/chat) |
| xiaomi | 9 | 14 | published_scoped_rates | listed | [source](https://mimo.mi.com/docs/en-US/price/pay-as-you-go) |
| xai | 8 | 16 | published_scoped_rates | missing_credentials | [source](https://docs.x.ai/developers/pricing) |
| perplexity | 42 | 58 | published_scoped_rates | missing_credentials | [source](https://docs.perplexity.ai/docs/agent-api/models) |
| together | 23 | 23 | published_scoped_rates | missing_credentials | [source](https://docs.together.ai/docs/serverless-models) |
| fireworks | 12 | 12 | published_scoped_rates | missing_credentials | [source](https://docs.fireworks.ai/serverless/pricing) |
| nebius | 30 | 54 | published_scoped_rates | listed | [source](https://tokenfactory.nebius.com/prices) |
| hyperbolic | 0 | 0 | unknown_or_non_token | missing_credentials | [source](https://www.hyperbolic.ai/pricing) |
| opencode | 85 | 85 | published_scoped_rates | http_401 | [source](https://opencode.ai/v2/docs/console/models/) |
| opencode-go | 29 | 29 | published_scoped_rates | http_401 | [source](https://opencode.ai/v2/docs/console/go/) |

Detailed conditions, non-token rates, credit units, timestamps and provider notes: `data/model-catalog-evidence.json`. Missing credentials and failed endpoints retain prior evidence without pretending current account access. Manual HTML evidence dates are not renewed by a model-list request.

## Changes in this refresh

- **Model listings:** 3,144 public identities, up from 3,007. The largest additions came from Hugging Face (+22), Cline (+20), Kilo (+15), OpenRouter (+15), Codex (+9), Mistral (+9), LLM7 (+8), Nebius (+5), Ollama (+5), NVIDIA (+4), Alibaba (+3), ModelScope (+2), OpenAI (+2), SiliconFlow (+2), Kimi (+1) and SambaNova (+1).
- **Pricing:** 2,740 observations, up from 2,617. OpenRouter and Kilo repriced many reseller routes (for example `deepseek/deepseek-v3.2`, `qwen/qwen3.6-27b`, `z-ai/glm-4.6`); OpenAI now records the 30-minute and 12-hour cache-write tiers exposed by the current pricing document.
- **New direct evidence:** Kimi K3.1 Pro and K3.1 Pro Highspeed, MiniMax M3.1 Flash (SambaNova/Together/Ollama), DeepSeek V4.1 Flash 1017 (Together/Fireworks/Alibaba/Cloudflare), Muse Spark Open (Together/Fireworks/Ollama), Reflection Beam, NVIDIA Nemotron 3.5 Super VL, GPT-OSS 120B/Fireworks, Ember-1, and broader SiliconFlow international rates.
- **Retirement:** Xiaomi MiMo V2.5 and V2.5 Pro were retired on 2026-10-21; the catalog marks them deprecated and disables their routes at hydration. Batch rates for V2.6 are now recorded separately. Kimi K2 series has a future end-of-December 2026 retirement recorded.
- **Unavailable source:** Windsurf's model page no longer exports `modelCostData`; its tables are client-rendered and account-scoped. The prior subscription/credit evidence is retained and `documentStatus` records the format change. Use the List Models API for account-specific pricing.
- **Seed/runtime:** `seed-providers.json` expanded from 241 to 500 routes (+259) and 296 missing routes were merged into the local `data/providers.json` (670 total) without inference. Generated routes carry `probe: false` so discovery records catalog-only status instead of probing every model.
- **Not re-dated:** Cerebras, Cohere, OVHcloud, Cloudflare (full table), NVIDIA, Kiro, OpenCode, OpenRouter account exposure, Cline and ModelScope retain their 2026-10-15 evidence where a current official machine-readable table was not available. A failed or unpublished lookup is not a price change.
