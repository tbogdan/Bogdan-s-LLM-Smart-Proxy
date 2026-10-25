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
  assert.equal(failure.scope, "route");
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
    assert.equal(runtime.isProviderAvailable(denied), true, "request/model evidence must not disable whole account");
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
  ];
  fs.writeFileSync(path.join(dir,"providers.json"),JSON.stringify({providers,groups:{"auto-text":"text"}}));
  const portServer = http.createServer(); await new Promise(resolve => portServer.listen(0,"127.0.0.1",resolve)); const port=portServer.address().port; await new Promise(resolve=>portServer.close(resolve));
  const child = spawn(process.execPath,["llm-proxy.js"],{cwd:path.join(__dirname,".."),env:{...process.env,DATA_DIR:dir,LLM_PROXY_PORT:String(port),FIXTURE_DISABLED_KEY:"one",FIXTURE_HEALTHY_KEY:"two",FIXTURE_POLICY_KEY:"three",FIXTURE_NATIVE_KEY:"four",MEMORY_ENABLED:"false",DEV_MODE:"false",LLM_PROXY_PROBE_ENABLED:"false"},stdio:["ignore","pipe","pipe"]});
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
  assert.deepEqual(calls.slice(beforeStream),["claude-fixture-disabled","gpt-fixture"]);
  const beforePolicy=calls.length; const policy=await send(providers[2].model);
  assert.equal(policy.status,403,await policy.text()); assert.equal(calls.length-beforePolicy,1);
  const beforeNative=calls.length; const native=await send(providers[3].model);
  assert.equal(native.status,403,await native.text()); assert.equal(calls.length,beforeNative,"native-only free route must not invoke paid fallback");
});
