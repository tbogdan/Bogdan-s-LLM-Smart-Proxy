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

test("OpenCode insufficient account funds disables Console routes but leaves Go eligible", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-funds-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createAccountAvailabilityStore({ dataDir: dir });
  t.after(() => store.close());
  const consoleRoute = { family: "opencode", name: "console-a", account_ref: "console" };
  const failure = classifyUpstreamFailure({
    providerKind: "opencode",
    status: 402,
    errorBody: JSON.stringify({ error: {
      type: "server_error",
      message: "Upstream request failed: Insufficient account funds",
    } }),
  });
  assert.equal(failure.kind, "credit_exhausted");
  assert.equal(failure.scope, "account");
  store.observe({ route: consoleRoute, failure });
  assert.equal(store.isEligible({ ...consoleRoute, name: "console-b" }), false);
  assert.equal(store.isEligible({ family: "opencode-go", name: "go-a", account_ref: "go" }), true);
  assert.equal(classifyUpstreamFailure({
    status: 400,
    errorBody: JSON.stringify({ request: "Insufficient account funds" }),
  }).kind, "invalid_request");
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

test('expired credentials disable every route sharing the account',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auth-account-'));const store=createAccountAvailabilityStore({dataDir:dir});const route={name:'A',family:'openai',account_ref:'one'};store.observe({route,failure:classifyUpstreamFailure({status:401,errorBody:JSON.stringify({error:{code:'token_expired'}})})});assert.equal(store.isEligible({...route,name:'B'}),false);assert.equal(store.isEligible({...route,name:'C',account_ref:'two'}),true);store.close();});


test("authentication quarantine follows credential while quota survives rotation and policy denial stays eligible", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-health-"));
  const store = createAccountAvailabilityStore({ dataDir: dir });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const route = { name: "a", family: "claude", account_ref: "one", key: "revoked" };
  store.observe({ route, failure: classifyUpstreamFailure({ status: 401 }) });
  assert.equal(store.isEligible({ ...route, name: "b" }), false);
  assert.equal(store.isEligible({ ...route, key: "rotated" }), true);
  const policy = { ...route, key: "policy" };
  store.observe({ route: policy, failure: classifyUpstreamFailure({ status: 403, errorBody: '{"error":{"type":"permission_error"}}' }) });
  assert.equal(store.isEligible(policy), true);
  store.observe({ route, failure: { kind: "credit_exhausted", scope: "account" } });
  assert.equal(store.isEligible({ ...route, key: "rotated" }), false);
});


test("legacy account auth evidence requalifies credentials without clearing quota", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-auth-"));
  const store = createAccountAvailabilityStore({ dataDir: dir });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const legacy = { name: "old", family: "claude", account_ref: "one" };
  store.observe({ route: legacy, failure: classifyUpstreamFailure({ status: 401 }) });
  const fresh = { ...legacy, key: "fresh", url: "https://api.anthropic.com/v1/messages" };
  assert.equal(store.isEligible(fresh), true);
  store.observe({ route: fresh, failure: classifyUpstreamFailure({ status: 401 }) });
  assert.equal(store.isEligible(fresh), false);
  assert.equal(store.isEligible({ ...fresh, key: "rotated" }), true);
  assert.equal(store.isEligible({ ...fresh, family: "other" }), true);
  assert.equal(store.isEligible({ ...fresh, url: "https://other.example/v1/messages" }), true);
  store.observe({ route: legacy, failure: { kind: "credit_exhausted", scope: "account" } });
  assert.equal(store.isEligible({ ...fresh, key: "rotated" }), false);
});
