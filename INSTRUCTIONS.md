# Bogdan LLM Smart Proxy Instructions

Start with [README](README.md), then [setup and client configuration](docs/operator/setup.md).

Use one stable explicit task ID for the current task; issue a new ID for new work. Keep ordinary continuations on their pinned model. Fallback requires unavailable quota/auth/transport or demonstrated capability mismatch. Honor the lifetime three-model ceiling and account-level limits.

Do not claim live access, cache savings or task quality from configuration alone. Run the documented tests and report observed versus estimated results separately.
