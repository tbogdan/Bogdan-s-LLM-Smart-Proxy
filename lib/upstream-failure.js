"use strict";
function classifyUpstreamFailure({
  providerKind = "",
  status = 0,
  headers = {},
  errorBody = "",
  transportError,
  now = Date.now(),
} = {}) {
  let parsed;
  try {
    parsed = typeof errorBody === "string" ? JSON.parse(errorBody) : errorBody;
  } catch {}
  const error = parsed?.error || parsed || {};
  const code = String(error.code || error.type || "").toLowerCase();
  const message = String(error.message || "")
    .slice(0, 1000)
    .toLowerCase();
  const retry = headers["retry-after"] ?? headers["Retry-After"];
  let retryAt = null;
  if (retry !== undefined) {
    const n = Number(retry);
    retryAt = Number.isFinite(n)
      ? now + Math.max(0, n) * 1000
      : Date.parse(retry);
    if (!Number.isFinite(retryAt)) retryAt = null;
  }
  const reset =
    headers["x-ratelimit-reset-requests"] || headers["x-ratelimit-reset"];
  let resetAt = null;
  if (reset) {
    const n = Number(reset);
    resetAt = Number.isFinite(n) && n > 1e9 ? n * 1000 : Date.parse(reset);
    if (!Number.isFinite(resetAt)) resetAt = null;
  }
  let kind = "unknown",
    scope = "route";
  if (
    /insufficient_quota|credit.*exhaust|insufficient.*credit|billing_hard_limit|balance.*insufficient/.test(
      code,
    ) ||
    ([402, 429].includes(status) &&
      /insufficient credits|insufficient (?:account )?funds|credit balance is too low|out of credits|exceeded your current quota/.test(
        message,
      ))
  ) {
    kind = "credit_exhausted";
    scope = "account";
  } else if (
    status === 401 ||
    /token_expired|invalid_token|authentication_error/.test(code)
  )
    {kind = "auth_expired";scope="account";}
  // A model disabled in the upstream catalog is not a denial of this action.
  // Match the known API envelope exactly; other 403 policy/auth denials stay terminal.
  else if (status === 403 && code === "api_error" && message === "upstream request failed: model access is disabled") {
    kind = "capability_mismatch";
    scope = "credential_model";
    // Model access can change; retry after a bounded interval, never an account ban.
    retryAt = now + 5 * 60_000;
    resetAt = null;
  }
  else if (status === 403) kind = "forbidden";
  else if (status === 429) {
    kind = "rate_limit";
    scope = /account|daily|monthly|quota/.test(code + " " + message)
      ? "account"
      : "quota_bucket";
  } else if (
    /context_length|unsupported_model|model_not_found|unsupported_api|unsupported.*tool/.test(
      code,
    )
  )
    kind = "capability_mismatch";
  else if (status >= 500 || transportError) kind = "transient";
  else if (status >= 400) kind = "invalid_request";
  return {
    kind,
    scope,
    retryAt,
    resetAt,
    evidence: { status, code, providerKind },
  };
}
module.exports = { classifyUpstreamFailure };
