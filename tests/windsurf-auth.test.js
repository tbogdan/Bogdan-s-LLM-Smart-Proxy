"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const auth = require("../lib/windsurf-auth");

test("createLoginUrl includes OAuth PKCE parameters", () => {
  const output = auth.createLoginUrl({
    clientId: "proxy-client",
    redirectUri: "http://127.0.0.1:3000/callback",
    state: "state-123",
    codeChallenge: "challenge-abc",
  });

  const url = new URL(output);
  assert.equal(url.origin, auth.AUTH_BASE_URL);
  assert.equal(url.searchParams.get("client_id"), "proxy-client");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:3000/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-abc");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("parseCallbackUrl returns code only when state matches", () => {
  const output = auth.parseCallbackUrl("http://127.0.0.1:3000/callback?code=auth-code&state=state-123", "state-123");

  assert.deepEqual(output, { code: "auth-code" });
});

test("parseCallbackUrl rejects missing code and state mismatch", () => {
  assert.throws(
    () => auth.parseCallbackUrl("http://127.0.0.1:3000/callback?state=state-123", "state-123"),
    /missing code/i,
  );
  assert.throws(
    () => auth.parseCallbackUrl("http://127.0.0.1:3000/callback?code=auth-code&state=wrong", "state-123"),
    /state/i,
  );
});

test("buildExchangeRequest returns JSON POST descriptor", () => {
  const output = auth.buildExchangeRequest({
    clientId: "proxy-client",
    code: "auth-code",
    redirectUri: "http://127.0.0.1:3000/callback",
    codeVerifier: "verifier-xyz",
  });

  assert.equal(output.method, "POST");
  assert.equal(output.headers["content-type"], "application/json");
  assert.match(output.url, new RegExp(`^${auth.AUTH_BASE_URL}`));
  assert.deepEqual(JSON.parse(output.body), {
    client_id: "proxy-client",
    grant_type: "authorization_code",
    code: "auth-code",
    redirect_uri: "http://127.0.0.1:3000/callback",
    code_verifier: "verifier-xyz",
  });
});

test("readHostToken returns host token by documented precedence", () => {
  assert.equal(
    auth.readHostToken({
      WINDSURF_API_KEY: "api-key",
      WINDSURF_ACCESS_TOKEN: "access-token",
      WINDSURF_TOKEN: "token",
    }),
    "api-key",
  );
  assert.equal(
    auth.readHostToken({
      WINDSURF_ACCESS_TOKEN: "access-token",
      WINDSURF_TOKEN: "token",
    }),
    "access-token",
  );
  assert.equal(auth.readHostToken({ WINDSURF_TOKEN: "token" }), "token");
  assert.equal(auth.readHostToken({}), "");
});
