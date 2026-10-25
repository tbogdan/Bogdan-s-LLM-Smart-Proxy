"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const scriptPath = "../scripts/sync-claude-credentials";
const future = () => Date.now() + 600000;
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sync-")); t.after(() => fs.rmSync(dir, {recursive:true,force:true})); return dir; }
test("sync exports only fresh access credentials from Keychain with private atomic file", t => {
  const {syncCredentials} = require(scriptPath);
  const dir=fixture(t), output=path.join(dir,"token.json"), expiresAt=future();
  syncCredentials({output, readKeychain:()=>JSON.stringify({claudeAiOauth:{accessToken:"fresh-access",refreshToken:"never-export",expiresAt}})});
  assert.deepEqual(JSON.parse(fs.readFileSync(output,"utf8")),{accessToken:"fresh-access",expiresAt});
  assert.equal(fs.statSync(output).mode & 0o777,0o600);
  assert.deepEqual(fs.readdirSync(dir),["token.json"]);
});
test("fallback used only when Keychain unavailable; stale or malformed Keychain never downgrades",t=>{
  const {syncCredentials}=require(scriptPath); const dir=fixture(t), output=path.join(dir,"token.json"), credentialsFile=path.join(dir,"source.json");
  fs.writeFileSync(credentialsFile,JSON.stringify({claudeAiOauth:{accessToken:"file-access",expiresAt:future()}}));
  syncCredentials({output,credentialsFile,readKeychain:()=>{throw new Error("unavailable");}});
  assert.equal(JSON.parse(fs.readFileSync(output)).accessToken,"file-access");
  for(const raw of ["broken",JSON.stringify({claudeAiOauth:{accessToken:"expired",expiresAt:1}})]) {
    assert.throws(()=>syncCredentials({output,credentialsFile,readKeychain:()=>raw}),/valid|expired/);
    assert.equal(JSON.parse(fs.readFileSync(output)).accessToken,"file-access");
  }
});
test("both hydrators and runtime refresh update only designated Claude credentials",t=>{
  const dir=fixture(t), output=path.join(dir,"token.json"); const old=process.env.LLM_PROXY_CLAUDE_CREDENTIAL_FILE;
  process.env.LLM_PROXY_CLAUDE_CREDENTIAL_FILE=output; t.after(()=>{if(old===undefined)delete process.env.LLM_PROXY_CLAUDE_CREDENTIAL_FILE;else process.env.LLM_PROXY_CLAUDE_CREDENTIAL_FILE=old;});
  fs.writeFileSync(output,JSON.stringify({accessToken:"rotated",expiresAt:future()}));
  const providers=require("../lib/providers"), state=require("../lib/state"), previous=state.PROVIDERS; t.after(()=>state.PROVIDERS=previous);
  const config={providers:[{name:"Claude",family:"claude",protocol:"anthropic",model:"claude/claude-sonnet-4-5",key_env:"CLAUDE_CODE_OAUTH_TOKEN",url:"https://api.anthropic.com/v1/messages"}]};
  for(const hydrate of [providers.hydrateSeedProviders,providers.hydrateProvidersFile]) assert.equal(hydrate(config).providers[0].key,"rotated");
  state.PROVIDERS=[{family:"claude",key_env:"CLAUDE_CODE_OAUTH_TOKEN",key:"old"},{family:"claude",key_env:"OTHER",key:"other"},{family:"other",key_env:"CLAUDE_CODE_OAUTH_TOKEN",key:"untouched"}];
  const oldReference=state.PROVIDERS[0];
  assert.equal(providers.refreshClaudeCredentials({force:true}),1);
  assert.equal(oldReference.key,"old");
  assert.deepEqual(state.PROVIDERS.map(p=>p.key),["rotated","other","untouched"]);
  fs.writeFileSync(output,JSON.stringify({accessToken:"expired",expiresAt:1}));
  assert.equal(providers.refreshClaudeCredentials({force:true}),0);
  assert.equal(state.PROVIDERS[0].key,"rotated");
});

test("sync keeps unchanged snapshots stable and rejects custom config directories",t=>{
 const {syncCredentials}=require(scriptPath),dir=fixture(t),output=path.join(dir,"token.json"),expiresAt=future();
 const options={output,readKeychain:()=>JSON.stringify({claudeAiOauth:{accessToken:"same",expiresAt}})};
 syncCredentials(options); const before=fs.statSync(output).ino; fs.chmodSync(output,0o644); syncCredentials(options);
 assert.equal(fs.statSync(output).ino,before);assert.equal(fs.statSync(output).mode&0o777,0o600);
 const old=process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR="/custom";
 try {assert.throws(()=>syncCredentials(options),/Custom Claude/);} finally {if(old===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=old;}
});
test("runtime rereads at most once per second and rejects oversized or missing snapshots",t=>{
 const dir=fixture(t),output=path.join(dir,"token.json"),providers=require("../lib/providers"),state=require("../lib/state"),oldEnv=process.env.LLM_PROXY_CLAUDE_CREDENTIAL_FILE,oldProviders=state.PROVIDERS;
 t.after(()=>{state.PROVIDERS=oldProviders;if(oldEnv===undefined)delete process.env.LLM_PROXY_CLAUDE_CREDENTIAL_FILE;else process.env.LLM_PROXY_CLAUDE_CREDENTIAL_FILE=oldEnv;});
 process.env.LLM_PROXY_CLAUDE_CREDENTIAL_FILE=output; state.PROVIDERS=[{family:"claude",key_env:"CLAUDE_CODE_OAUTH_TOKEN",key:"first"}];
 fs.writeFileSync(output,JSON.stringify({accessToken:"second",expiresAt:future()})); providers.refreshClaudeCredentials({force:true});
 fs.writeFileSync(output,JSON.stringify({accessToken:"third",expiresAt:future()})); assert.equal(providers.refreshClaudeCredentials(),0);assert.equal(state.PROVIDERS[0].key,"second");
 assert.equal(providers.refreshClaudeCredentials({force:true}),1);
 fs.writeFileSync(output,"x".repeat(65537));assert.equal(providers.refreshClaudeCredentials({force:true}),0);
 fs.unlinkSync(output);assert.equal(providers.refreshClaudeCredentials({force:true}),0);assert.equal(state.PROVIDERS[0].key,"third");
});
