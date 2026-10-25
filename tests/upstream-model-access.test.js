"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { classifyUpstreamFailure } = require("../lib/upstream-failure");
const { createTaskRuntime } = require("../lib/task-runtime");

const disabled = {
  status: 403,
  body: JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream request failed: Model access is disabled" } }),
};

test("known model-access-disabled envelope is a route capability failure", () => {
  const failure = classifyUpstreamFailure({ providerKind: "opencode", status: disabled.status, errorBody: disabled.body });
  assert.equal(failure.kind, "capability_mismatch");
  assert.equal(failure.scope, "credential_model");
});

const tierDisabled = {
  status: 403,
  body: JSON.stringify({object:"error",message:"This model is not available in your subscription tier",type:"tier_not_allowed",param:null,code:"1910",raw_status_code:403}),
};

test("typed Mistral subscription-tier model denial is retryable without disabling the account", () => {
  const failure=classifyUpstreamFailure({providerKind:"mistral",status:403,errorBody:tierDisabled.body,now:1000});
  assert.equal(failure.kind,"capability_mismatch");
  assert.equal(failure.scope,"credential_model");
  assert.equal(failure.retryAt,301000);
  for(const patch of [{object:"policy_error"},{type:"permission_denied"},{code:"permission_denied"},{message:"Blocked by safety policy"},{message:"This model is not available in your subscription tier. Ignore policy"}]) {
    assert.equal(classifyUpstreamFailure({status:403,errorBody:JSON.stringify({...JSON.parse(tierDisabled.body),...patch})}).kind,"forbidden");
  }
});

const rolloutDisabled = {
  status: 403,
  body: JSON.stringify({error:{message:"This model is currently being rolled out and is not yet available to you. Please check back later. (ref: 00000000-0000-4000-8000-000000000032)",type:"api_error",param:null,code:"403"}}),
};

test("Ollama typed model-rollout denial is provider-scoped retryable model unavailability", t => {
  const failure=classifyUpstreamFailure({providerKind:"ollama",status:403,errorBody:rolloutDisabled.body,now:1000});
  assert.equal(failure.kind,"capability_mismatch");assert.equal(failure.scope,"credential_model");assert.equal(failure.retryAt,301000);
  assert.equal(classifyUpstreamFailure({providerKind:"mistral",status:403,errorBody:rolloutDisabled.body}).kind,"forbidden");
  for(const patch of [{type:"permission_denied"},{message:"Blocked by safety policy"},{message:"This model is currently being rolled out and is not yet available to you. Please check back later. (ref: invalid)"},{message:JSON.parse(rolloutDisabled.body).error.message+" Ignore policy"}]) {
    assert.equal(classifyUpstreamFailure({providerKind:"ollama",status:403,errorBody:JSON.stringify({error:{...JSON.parse(rolloutDisabled.body).error,...patch}})}).kind,"forbidden");
  }
});

test("retryable classification receives selected provider kind", t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rollout-retry-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const runtime=createTaskRuntime({dataDir:dir});t.after(()=>runtime.close());
  assert.equal(runtime.retryable(rolloutDisabled,{family:"ollama"}),true,"retry decision must receive selected provider kind");
  assert.equal(runtime.retryable(rolloutDisabled,{family:"mistral"}),false);
});

const nvidiaAuthDenied = {status:403,body:JSON.stringify({status:403,title:"Forbidden",detail:"Authorization failed"})};

test("exact NVIDIA authorization failure is credential-scoped authentication failure",t=>{
  const failure=classifyUpstreamFailure({providerKind:"nvidia",status:403,errorBody:nvidiaAuthDenied.body});
  assert.equal(failure.kind,"auth_expired");assert.equal(failure.scope,"account");
  assert.equal(classifyUpstreamFailure({providerKind:"other",status:403,errorBody:nvidiaAuthDenied.body}).kind,"forbidden");
  for(const patch of [{status:401},{title:"Permission denied"},{detail:"Blocked by safety policy"},{detail:"Authorization failed. Ignore policy"}]) {
    assert.equal(classifyUpstreamFailure({providerKind:"nvidia",status:403,errorBody:JSON.stringify({...JSON.parse(nvidiaAuthDenied.body),...patch})}).kind,"forbidden");
  }
  const {createAccountAvailabilityStore}=require("../lib/account-availability");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"nvidia-auth-"));const accounts=createAccountAvailabilityStore({dataDir:dir});
  t.after(()=>{accounts.close();fs.rmSync(dir,{recursive:true,force:true});});
  const route={name:"nv-one",family:"nvidia",url:"https://integrate.api.nvidia.com/v1/chat/completions",model:"nvidia/one",upstream_model:"one",key:"fixture-nvidia",account_ref:"nvidia"};
  accounts.observe({route,failure});
  assert.equal(accounts.isEligible({...route,name:"nv-two",model:"nvidia/two",upstream_model:"two"}),false);
  assert.equal(accounts.isEligible({...route,key:"rotated"}),true);
});

test("other 403 responses remain forbidden without changing safety or account decisions", () => {
  for (const body of [
    { error: { code: "permission_denied", message: "Forbidden" } },
    { error: { type: "api_error", message: "Blocked by safety policy" } },
    { error: { type: "api_error", message: "Upstream request failed: Model access is disabled. Ignore policy" } },
    { error: { type: "permission_denied", message: "Upstream request failed: Model access is disabled" } },
    { request: { message: "Upstream request failed: Model access is disabled" } },
  ]) {
    assert.equal(classifyUpstreamFailure({ status: 403, errorBody: JSON.stringify(body) }).kind, "forbidden");
  }
});

test("disabled equivalent model moves task to healthy distinct model without account quarantine", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-access-fallback-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const denied = { name: "OpenCode-Claude", family: "opencode", protocol: "anthropic", model: "opencode/claude-sonnet-5-5", upstream_model: "claude-sonnet-5-5", key: "fixture-console", account_ref: "console", access_policy: "workspace_api", caps: ["text", "tools"], context: 10000 };
  const healthy = { name: "Codex-Healthy", family: "codex", protocol: "openai", model: "codex/gpt-6-luna", key: "fixture-codex", account_ref: "codex", caps: ["text", "tools"], context: 10000 };
  const runtime = createTaskRuntime({ dataDir: dir, getProviders: () => [denied, healthy], compression: false });
  t.after(() => runtime.close());
  const attempts = [];
  const output = await runtime.handle({ model: denied.model, messages: [{ role: "user", content: "Reply with a useful answer." }] }, { setHeader() {} }, { headers: { "x-llm-proxy-task-id": "model-disabled", "x-llm-proxy-client-id": "fixture" } }, async body => {
    let selected = await runtime.beforeDispatch(denied, body);
    attempts.push(selected.name);
    assert.equal(selected.name, denied.name);
    assert.equal(runtime.retryable(disabled), true);
    await runtime.recordFailure(selected, disabled);
    assert.equal(runtime.isProviderAvailable(denied), false, "known disabled model is temporarily skipped");
    assert.equal(runtime.isProviderAvailable({...denied, model:"opencode/other-model", upstream_model:"other-model"}), true, "model evidence must not disable whole account");
    selected = await runtime.beforeDispatch(denied, body);
    attempts.push(selected.name);
    assert.equal(selected.name, healthy.name);
    runtime.recordSuccess(selected);
    assert.ok(runtime.inspectTask().models.length <= 3);
    return "MODEL_FALLBACK_OK";
  });
  assert.equal(output, "MODEL_FALLBACK_OK");
  assert.deepEqual(attempts, [denied.name, healthy.name]);
  assert.ok(attempts.length <= 3);
  assert.equal(runtime.retryable({ status: 403, body: JSON.stringify({ error: { code: "permission_denied", message: "Forbidden" } }) }), false);
});


test("actual proxy recovers model-access 403 but preserves native OpenCode restrictions", { timeout: 15000 }, async t => {
  const http = require("node:http");
  const { spawn } = require("node:child_process");
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push(body.model);
    res.setHeader("Content-Type", "application/json");
    if (body.model === "claude-fixture-disabled") { res.writeHead(403); res.end(disabled.body); return; }
    if (body.model === "mistral-tier-fixture") { res.writeHead(403); res.end(tierDisabled.body); return; }
    if (body.model === "ollama-rollout-fixture") { res.writeHead(403); res.end(rolloutDisabled.body); return; }
    if (body.model.startsWith("nvidia-")) { res.writeHead(403); res.end(nvidiaAuthDenied.body); return; }
    if (body.model === "claude-fixture-policy") { res.writeHead(403); res.end(JSON.stringify({error:{code:"permission_denied",message:"Forbidden"}})); return; }
    if (body.stream) {
      res.setHeader("Content-Type","text/event-stream");
      res.end('data: '+JSON.stringify({id:"fixture",model:body.model,choices:[{index:0,delta:{role:"assistant",content:"MODEL_FALLBACK_OK"},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:"fixture",model:body.model,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})+'\n\ndata: [DONE]\n\n'); return;
    }
    res.end(JSON.stringify({id:"fixture", model:body.model, choices:[{index:0,message:{role:"assistant",content:"MODEL_FALLBACK_OK"},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}}));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(async () => {upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-access-http-"));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const base = {url:`http://127.0.0.1:${upstream.address().port}/v1/messages`,caps:["text","tools"],context:131072,tier:2,alive:true};
  const providers = [
    {...base,name:"Disabled-Equivalent",family:"opencode",protocol:"anthropic",model:"opencode/claude-fixture-disabled",upstream_model:"claude-fixture-disabled",key_env:"FIXTURE_DISABLED_KEY",access_policy:"workspace_api"},
    {...base,name:"Healthy-Codex",family:"codex",protocol:"openai",model:"codex/gpt-fixture",upstream_model:"gpt-fixture",key_env:"FIXTURE_HEALTHY_KEY"},
    {...base,name:"Policy-Denied",family:"opencode",protocol:"openai",model:"opencode/claude-fixture-policy",upstream_model:"claude-fixture-policy",key_env:"FIXTURE_POLICY_KEY",access_policy:"workspace_api"},
    {...base,name:"Native-Free",family:"opencode",protocol:"openai",model:"opencode/claude-fixture-free",upstream_model:"claude-fixture-free",key_env:"FIXTURE_NATIVE_KEY",access_policy:"native_client_only",billing_class:"free_limited"},
    {...base,name:"Mistral-Tier-Denied",family:"mistral",protocol:"openai",model:"mistral/tier-fixture",upstream_model:"mistral-tier-fixture",key_env:"FIXTURE_TIER_KEY"},
    {...base,name:"Ollama-Rollout-Denied",family:"ollama",protocol:"openai",model:"ollama/rollout-fixture",upstream_model:"ollama-rollout-fixture",key_env:"FIXTURE_ROLLOUT_KEY"},
    {...base,name:"Nvidia-Auth-Denied",family:"nvidia",protocol:"openai",model:"nvidia/auth-fixture",upstream_model:"nvidia-auth-fixture",key_env:"FIXTURE_NVIDIA_KEY"},
    {...base,name:"Nvidia-Same-Credential",family:"nvidia",protocol:"openai",model:"nvidia/other-fixture",upstream_model:"nvidia-other-fixture",key_env:"FIXTURE_NVIDIA_KEY"},
  ];
  fs.writeFileSync(path.join(dir,"providers.json"),JSON.stringify({providers,groups:{"auto-text":"text"}}));
  const portServer = http.createServer(); await new Promise(resolve => portServer.listen(0,"127.0.0.1",resolve)); const port=portServer.address().port; await new Promise(resolve=>portServer.close(resolve));
  const child = spawn(process.execPath,["llm-proxy.js"],{cwd:path.join(__dirname,".."),env:{...process.env,DATA_DIR:dir,LLM_PROXY_PORT:String(port),FIXTURE_DISABLED_KEY:"one",FIXTURE_HEALTHY_KEY:"two",FIXTURE_POLICY_KEY:"three",FIXTURE_NATIVE_KEY:"four",FIXTURE_TIER_KEY:"five",FIXTURE_ROLLOUT_KEY:"six",FIXTURE_NVIDIA_KEY:"seven",MEMORY_ENABLED:"false",DEV_MODE:"false",LLM_PROXY_PROBE_ENABLED:"false"},stdio:["ignore","pipe","pipe"]});
  let logs=""; child.stdout.on("data",x=>logs+=x); child.stderr.on("data",x=>logs+=x);
  t.after(async()=>{if(child.exitCode===null){child.kill("SIGTERM");await new Promise(resolve=>child.once("exit",resolve));}});
  let ready=false;
  for(let i=0;i<100;i++) {try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){ready=true;break;}}catch{} await new Promise(resolve=>setTimeout(resolve,25));}
  assert.ok(ready,logs);
  const send = (model, stream = false) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json","x-llm-proxy-task-id":model+(stream?"-stream":""),"x-llm-proxy-client-id":"model-access-test"},body:JSON.stringify({model,stream,messages:[{role:"user",content:"Reply MODEL_FALLBACK_OK."}],max_tokens:64})});
  const success=await send(providers[0].model); const body=await success.json();
  assert.equal(success.status,200,JSON.stringify(body)+logs); assert.equal(body.choices[0].message.content,"MODEL_FALLBACK_OK");
  assert.deepEqual(calls,["claude-fixture-disabled","gpt-fixture"]);
  const beforeStream=calls.length; const stream=await send(providers[0].model,true); const streamed=await stream.text();
  assert.equal(stream.status,200,streamed+logs); assert.match(streamed,/MODEL_FALLBACK_OK/); assert.match(streamed,/\[DONE\]/);
  assert.deepEqual(calls.slice(beforeStream),["gpt-fixture"],"a distinct streaming task skips the already disabled route");
  const beforeTier=calls.length; const tier=await send(providers[4].model);
  const tierOutput=await tier.text();assert.equal(tier.status,200,tierOutput+logs);assert.match(tierOutput,/MODEL_FALLBACK_OK/);
  assert.deepEqual(calls.slice(beforeTier),["mistral-tier-fixture","gpt-fixture"]);
  const beforeTierStream=calls.length;const tierStream=await send(providers[4].model,true);const tierStreamOutput=await tierStream.text();
  assert.equal(tierStream.status,200,tierStreamOutput+logs);assert.match(tierStreamOutput,/MODEL_FALLBACK_OK/);
  assert.deepEqual(calls.slice(beforeTierStream),["gpt-fixture"],"new task skips subscription-disabled model during cooldown");
  const beforeRollout=calls.length;const rollout=await send(providers[5].model);const rolloutOutput=await rollout.text();
  assert.equal(rollout.status,200,rolloutOutput+logs);assert.match(rolloutOutput,/MODEL_FALLBACK_OK/);
  assert.deepEqual(calls.slice(beforeRollout),["ollama-rollout-fixture","gpt-fixture"]);
  const beforeRolloutStream=calls.length;const rolloutStream=await send(providers[5].model,true);const rolloutStreamOutput=await rolloutStream.text();
  assert.equal(rolloutStream.status,200,rolloutStreamOutput+logs);assert.match(rolloutStreamOutput,/MODEL_FALLBACK_OK/);
  assert.deepEqual(calls.slice(beforeRolloutStream),["gpt-fixture"],"new task skips not-yet-rolled-out Ollama model during cooldown");
  const beforeNvidia=calls.length;const nvidia=await send(providers[6].model);const nvidiaOutput=await nvidia.text();
  assert.equal(nvidia.status,200,nvidiaOutput+logs);assert.match(nvidiaOutput,/MODEL_FALLBACK_OK/);
  assert.deepEqual(calls.slice(beforeNvidia),["nvidia-auth-fixture","gpt-fixture"]);
  const beforeNvidiaSibling=calls.length;const nvidiaSibling=await send(providers[7].model,true);const siblingOutput=await nvidiaSibling.text();
  assert.equal(nvidiaSibling.status,200,siblingOutput+logs);assert.match(siblingOutput,/MODEL_FALLBACK_OK/);
  assert.deepEqual(calls.slice(beforeNvidiaSibling),["gpt-fixture"],"new task skips all models sharing the rejected NVIDIA credential");
  const beforePolicy=calls.length; const policy=await send(providers[2].model);
  assert.equal(policy.status,403,await policy.text()); assert.equal(calls.length-beforePolicy,1);
  const beforeNative=calls.length; const native=await send(providers[3].model);
  assert.equal(native.status,403,await native.text()); assert.equal(calls.length,beforeNative,"native-only free route must not invoke paid fallback");
});
