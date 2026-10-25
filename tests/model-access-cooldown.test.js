"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {createAccountAvailabilityStore} = require("../lib/account-availability");
const {classifyUpstreamFailure} = require("../lib/upstream-failure");
const {createTaskRuntime} = require("../lib/task-runtime");
const payload = JSON.stringify({error:{type:"api_error",message:"Upstream request failed: Model access is disabled"}});
const route = {name:"Disabled",family:"opencode",url:"https://opencode.ai/zen/v1/messages",model:"opencode/claude-fixture",upstream_model:"claude-fixture",key:"fixture-credential",account_ref:"console",protocol:"anthropic",caps:["text","tools"],context:10000};
const failureAt = now => classifyUpstreamFailure({providerKind:"opencode",status:403,errorBody:payload,now});
function temp(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),"model-access-cooldown-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test("exact disabled-model envelope has bounded credential/model retry scope",()=>{
 const failure=failureAt(1000);
 assert.equal(failure.kind,"capability_mismatch");
 assert.equal(failure.scope,"credential_model");
 assert.equal(failure.retryAt,301000);
 assert.equal(classifyUpstreamFailure({status:403,errorBody:payload,headers:{"retry-after":"999999999"},now:1000}).retryAt,301000,"upstream headers cannot extend the cooldown indefinitely");
 assert.equal(classifyUpstreamFailure({status:403,errorBody:JSON.stringify({error:{type:"api_error",message:"Blocked by safety policy"}}),now:1000}).kind,"forbidden");
});

test("disabled model persists across tasks without blocking other models, credentials or endpoints",t=>{
 const dir=temp(t);let store=createAccountAvailabilityStore({dataDir:dir,now:()=>1000});t.after(()=>store.close());
 store.observe({route,failure:failureAt(1000)});
 assert.equal(store.isEligible(route),false);
 assert.equal(store.isEligible({...route,name:"Alias"}),false);
 for(const other of [{...route,key:"rotated"},{...route,upstream_model:"different-model"},{...route,url:"https://opencode.ai/go/v1/messages"},{...route,family:"other"}]) assert.equal(store.isEligible(other),true);
 const anonymous={...route,key:"",account_ref:"anonymous-one"};
 store.observe({route:anonymous,failure:failureAt(1000)});
 assert.equal(store.isEligible(anonymous),false);
 assert.equal(store.isEligible({...anonymous,account_ref:"anonymous-two"}),true);
 store.recordSuccess({...route,upstream_model:"different-model"});
 assert.equal(store.isEligible(route),false,"unrelated success cannot clear the rejected model");
 store.close();store=createAccountAvailabilityStore({dataDir:dir,now:()=>1001});
 assert.equal(store.isEligible(route),false,"new store/task preserves cooldown evidence");
 const disk=fs.readdirSync(dir).filter(name=>name.endsWith(".json")).map(name=>fs.readFileSync(path.join(dir,name),"utf8")).join("");
 assert.ok(!disk.includes(route.key));
});

test("expiry allows only one recovery probe and success clears disabled-model state",t=>{
 const dir=temp(t);let now=1000;const store=createAccountAvailabilityStore({dataDir:dir,now:()=>now});t.after(()=>store.close());
 store.observe({route,failure:failureAt(now)});now=300999;assert.equal(store.isEligible(route),false);
 now=301000;assert.equal(store.beginHalfOpen(route),true);assert.equal(store.beginHalfOpen(route),false);
 store.recordSuccess(route);assert.equal(store.isEligible(route),true);
});

test("explicit reset of rejected model requires evidence and does not clear account credit blocks",t=>{
 const dir=temp(t);const store=createAccountAvailabilityStore({dataDir:dir,now:()=>1000});t.after(()=>store.close());
 store.observe({route,failure:failureAt(1000)});
 assert.throws(()=>store.resetModelAccess({route}),/evidence/i);
 store.resetModelAccess({route,evidence:"Operator enabled this model"});assert.equal(store.isEligible(route),true);
 store.observe({route,failure:{kind:"credit_exhausted",scope:"account",retryAt:null}});
 store.resetModelAccess({route,evidence:"Model enabled"});assert.equal(store.isEligible(route),false);
});

test("request-specific capability mismatch is never persisted as availability loss",t=>{
 const dir=temp(t);const store=createAccountAvailabilityStore({dataDir:dir,now:()=>1000});t.after(()=>store.close());
 for(const code of ["context_length_exceeded","unsupported_tool"]) {
  const failure=classifyUpstreamFailure({status:400,errorBody:JSON.stringify({error:{code}}),now:1000});
  assert.equal(failure.kind,"capability_mismatch");store.observe({route,failure});assert.equal(store.isEligible(route),true);
 }
});

test("a later runtime task skips the disabled equivalent model before any dispatch",async t=>{
 const dir=temp(t);const healthy={...route,name:"Healthy",family:"codex",model:"codex/healthy",upstream_model:"healthy",key:"healthy",protocol:"openai",account_ref:"codex"};
 let runtime=createTaskRuntime({dataDir:dir,getProviders:()=>[route,healthy],now:()=>1000,compression:false});t.after(()=>runtime.close());
 const body={model:route.model,messages:[{role:"user",content:"Give a useful answer."}]};
 await runtime.handle({...body},{setHeader(){}},{headers:{"x-llm-proxy-task-id":"first","x-llm-proxy-client-id":"fixture"}},async prepared=>{
  const first=await runtime.beforeDispatch(route,prepared);assert.equal(first.name,route.name);
  await runtime.recordFailure(first,{status:403,body:payload});return "first-failure-recorded";
 });
 assert.equal(runtime.isProviderAvailable(route),false);
 runtime.close();runtime=createTaskRuntime({dataDir:dir,getProviders:()=>[route,healthy],now:()=>1001,compression:false});
 await runtime.handle({...body},{setHeader(){}},{headers:{"x-llm-proxy-task-id":"second","x-llm-proxy-client-id":"fixture"}},async prepared=>{
  const selected=await runtime.beforeDispatch(route,prepared);assert.equal(selected.name,healthy.name);runtime.recordSuccess(selected);return "ok";
 });
});
