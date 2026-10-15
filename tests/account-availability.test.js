const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { classifyUpstreamFailure } = require("../lib/upstream-failure");
const {
  createAccountAvailabilityStore,
} = require("../lib/account-availability");
test("quota evidence scopes empty credits to one account and persists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-"));
  let now = 1000;
  const a = { family: "openai", name: "a", account_ref: "one" },
    b = { ...a, name: "b" },
    c = { ...a, account_ref: "two" };
  let store = createAccountAvailabilityStore({ dataDir: dir, now: () => now });
  store.observe({
    route: a,
    failure: classifyUpstreamFailure({
      status: 429,
      errorBody: JSON.stringify({ error: { code: "insufficient_quota" } }),
      now,
    }),
  });
  assert.equal(store.isEligible(b), false);
  assert.equal(store.isEligible(c), true);
  store.close();
  store = createAccountAvailabilityStore({ dataDir: dir, now: () => now });
  assert.equal(store.isEligible(a), false);
  store.close();
});
test("retry-after is honored but timeout and request echoes are not depleted credits", () => {
  assert.equal(
    classifyUpstreamFailure({
      status: 429,
      headers: { "retry-after": "2" },
      now: 1000,
    }).retryAt,
    3000,
  );
  assert.equal(
    classifyUpstreamFailure({ transportError: new Error("timeout") }).kind,
    "transient",
  );
  assert.equal(
    classifyUpstreamFailure({
      status: 400,
      errorBody: JSON.stringify({ request: "credits exhausted" }),
    }).kind,
    "invalid_request",
  );
});

test("expired circuit allows one recovery probe and success reopens account", () => {
  let now = 1000;
  const s = createAccountAvailabilityStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "half-open-")),
    now: () => now,
  });
  const route = { family: "openai", name: "A", account_ref: "shared" };
  s.observe({
    route,
    failure: { kind: "rate_limit", scope: "quota_bucket", retryAt: 2000 },
  });
  assert.equal(s.beginHalfOpen(route), false);
  now = 2001;
  assert.equal(s.beginHalfOpen(route), true);
  assert.equal(s.beginHalfOpen(route), false);
  s.recordSuccess(route);
  assert.equal(s.isEligible(route), true);
  s.close();
});
