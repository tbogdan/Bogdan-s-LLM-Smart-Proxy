"use strict";

const AUTH_BASE_URL = "https://auth.windsurf.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;

function createLoginUrl({ clientId, redirectUri, state, codeChallenge }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function parseCallbackUrl(url, expectedState) {
  const parsed = new URL(url);
  const state = parsed.searchParams.get("state");
  if (state !== expectedState) {
    throw new Error("Windsurf auth state mismatch");
  }

  const code = parsed.searchParams.get("code");
  if (!code) {
    throw new Error("Windsurf auth callback missing code");
  }

  return { code };
}

function buildExchangeRequest({ clientId, code, redirectUri, codeVerifier }) {
  return {
    url: TOKEN_URL,
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  };
}

function readHostToken(env = process.env) {
  return env.WINDSURF_API_KEY || env.WINDSURF_ACCESS_TOKEN || env.WINDSURF_TOKEN || "";
}

module.exports = {
  AUTH_BASE_URL,
  AUTHORIZE_URL,
  TOKEN_URL,
  createLoginUrl,
  parseCallbackUrl,
  buildExchangeRequest,
  readHostToken,
};
