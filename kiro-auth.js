#!/usr/bin/env node
/**
 * Kiro OAuth flow: opens browser → user logs in → captures refresh token → saves to .env
 * Usage: node kiro-auth.js [--env-file .env]
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev';
const PORTAL_URL = 'https://app.kiro.dev';
const CALLBACK_PORTS = [3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153];
const CALLBACK_PATHS = ['/oauth/callback', '/signin/callback'];
const TIMEOUT_MS = 600_000; // 10 minutes

const envFile = process.argv.includes('--env-file')
  ? process.argv[process.argv.indexOf('--env-file') + 1]
  : '.env';

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

function openBrowser(url) {
  // url is a static string we build — safe to pass as argument
  const platform = process.platform;
  const [cmd, args] =
    platform === 'darwin' ? ['open', [url]] :
    platform === 'win32'  ? ['cmd', ['/c', 'start', url]] :
                            ['xdg-open', [url]];
  execFile(cmd, args, err => {
    if (err) console.log('(Could not open browser automatically)');
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'KiroGateway-setup/1.0',
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function updateEnvFile(filePath, key, value) {
  const abs = path.resolve(filePath);
  let content = '';
  if (fs.existsSync(abs)) content = fs.readFileSync(abs, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(abs, content);
}

async function findFreePort() {
  for (const port of CALLBACK_PORTS) {
    const free = await new Promise(resolve => {
      const s = http.createServer();
      s.listen(port, () => { s.close(() => resolve(true)); });
      s.on('error', () => resolve(false));
    });
    if (free) return port;
  }
  throw new Error('No callback port available');
}

async function waitForCallback(port, expectedState) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Auth timeout (10 min)'));
    }, TIMEOUT_MS);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (!CALLBACK_PATHS.some(p => url.pathname === p)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Auth failed: ' + escapeHtml(error) + '</h2><p>Close this tab.</p></body></html>');
        clearTimeout(timer);
        server.close();
        reject(new Error('Auth error: ' + error));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>State mismatch — try again</h2></body></html>');
        clearTimeout(timer);
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body>
        <h2>✅ Kiro auth successful!</h2>
        <p>Token captured. You can close this tab.</p>
        <script>setTimeout(()=>window.close(),2000)</script>
      </body></html>`);

      clearTimeout(timer);
      server.close();

      const loginOption = url.searchParams.get('login_option') || 'google';
      const callbackPath = url.pathname;
      resolve({ code, loginOption, callbackPath });
    });

    server.listen(port);
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function main() {
  console.log('\n=== Kiro Auth Setup ===\n');

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const port = await findFreePort();
  const redirectUri = `http://localhost:${port}`;

  const params = new URLSearchParams({
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    redirect_from: 'KiroIDE',
  });

  const authUrl = `${PORTAL_URL}/signin?${params.toString()}`;

  console.log('Opening browser for Kiro login...');
  console.log('\n  ' + authUrl + '\n');
  console.log('(If browser did not open, copy URL above)\n');
  console.log('Waiting for callback on port', port, '...\n');

  openBrowser(authUrl);

  let callbackData;
  try {
    callbackData = await waitForCallback(port, state);
  } catch (err) {
    console.error('Auth failed:', err.message);
    process.exit(1);
  }

  console.log('Callback received, exchanging code for tokens...');

  const { code, loginOption, callbackPath } = callbackData;
  const fullRedirectUri = `${redirectUri}${callbackPath}?login_option=${loginOption}`;

  const result = await postJson(`${AUTH_ENDPOINT}/oauth/token`, {
    code,
    code_verifier: codeVerifier,
    redirect_uri: fullRedirectUri,
  });

  if (result.status !== 200 || !result.body.refreshToken) {
    console.error('Token exchange failed:', result.status, JSON.stringify(result.body));
    process.exit(1);
  }

  const { accessToken, refreshToken, profileArn, expiresIn } = result.body;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // Save to .env
  updateEnvFile(envFile, 'REFRESH_TOKEN', refreshToken);
  if (profileArn) updateEnvFile(envFile, 'PROFILE_ARN', profileArn);

  // Mirror to Kiro's own cache so IDE stays in sync
  const cacheDir = path.join(process.env.HOME, '.aws', 'sso', 'cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'kiro-auth-token.json'),
    JSON.stringify({ accessToken, refreshToken, profileArn, expiresAt, authMethod: 'social', provider: 'Google' }, null, 2)
  );

  console.log('\n✅ Done!');
  console.log('  REFRESH_TOKEN → ' + envFile);
  if (profileArn) console.log('  PROFILE_ARN   →', profileArn);
  console.log('  Token expires:', expiresAt);
  console.log('\nRun to apply:');
  console.log('  docker compose --profile kiro restart kiro-gateway\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
