"use strict";

// Codex uses ModelsResponse, not the OpenAI API's {object, data} catalog.
// Wire schema: openai/codex, codex-rs/protocol/src/openai_models.rs.
function codexModelsResponse(catalog) {
  return { models: (catalog.data || []).filter(row => row.id && row.owned_by !== "local-embedding").map((row, index) => ({
    slug: row.id,
    display_name: row.display_name || row.id,
    description: row.description || null,
    base_instructions: "You are Codex, a coding assistant. Follow the user's instructions, use the available tools to inspect and verify your work, and report results accurately.",
    supported_reasoning_levels: (row.supported_thinking_efforts || []).map(effort => ({ effort, description: effort })),
    shell_type: "unified_exec",
    // Keep the client's tool catalog compact; namespace custom tools are
    // translated by the Responses bridge, including incremental declarations.
    tool_mode: "code_mode_only",
    supports_search_tool: row.supports_search_tool === true,
    use_responses_lite: true,
    visibility: "list",
    supported_in_api: true,
    priority: Number.isInteger(row.priority) ? row.priority : index,
    support_verbosity: row.supports_verbosity === true,
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    input_modalities: (row.input_modalities || ["text"]).filter(value => ["text", "image", "audio"].includes(value)),
    ...(Number.isFinite(row.context_window) ? { context_window: row.context_window } : {}),
    ...(Number.isFinite(row.max_context_window) ? { max_context_window: row.max_context_window } : {}),
  })) };
}

module.exports = { codexModelsResponse };
