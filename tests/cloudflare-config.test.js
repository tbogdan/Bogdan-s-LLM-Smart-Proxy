"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const providers=require("../lib/providers");
const {createTaskRuntime}=require("../lib/task-runtime");
const account="0123456789abcdef0123456789abcdef";
const placeholder="https://api.cloudflare.com/client/v4/accounts/me/ai/v1/chat/completions";
const route={name:"CF-Missing-Account",family:"cloudflare",protocol:"openai",model:"cloudflare/fixture",upstream_model:"fixture",url:placeholder,default_key:"fixture",caps:["text"],context:10000};
function setAccount(t,value){const old=process.env.CLOUDFLARE_ACCOUNT_ID;if(value===undefined)delete process.env.CLOUDFLARE_ACCOUNT_ID;else process.env.CLOUDFLARE_ACCOUNT_ID=value;t.after(()=>{if(old===undefined)delete process.env.CLOUDFLARE_ACCOUNT_ID;else process.env.CLOUDFLARE_ACCOUNT_ID=old;});}

test("unresolved Cloudflare account is not eligible in seed and runtime-file hydration",t=>{
 setAccount(t,undefined);
 for(const hydrate of [providers.hydrateSeedProviders,providers.hydrateProvidersFile]) {
  const result=hydrate({providers:[route]}).providers[0];
  assert.equal(result.alive,false);assert.equal(result.configuration_status,"cloudflare_account_not_configured");assert.match(result.disabled_reason,/Cloudflare.*account.*32/i);
  assert.equal(result.url,placeholder);
 }
});

test("only valid 32hex account IDs resolve the Cloudflare API placeholder",t=>{
 setAccount(t,undefined);
 for(const value of ["fixture-account","me","a".repeat(31),"a".repeat(33),"a".repeat(32)+"/other"]) {
  process.env.CLOUDFLARE_ACCOUNT_ID=value;
  for(const hydrate of [providers.hydrateSeedProviders,providers.hydrateProvidersFile]) {
   const result=hydrate({providers:[route]}).providers[0];assert.equal(result.alive,false);assert.equal(result.url,placeholder);assert.ok(!result.disabled_reason.includes(value));
  }
 }
 process.env.CLOUDFLARE_ACCOUNT_ID=account;
 for(const hydrate of [providers.hydrateSeedProviders,providers.hydrateProvidersFile]) {
  const result=hydrate({providers:[route]}).providers[0];assert.equal(result.alive,true);assert.equal(result.url,placeholder.replace("/me/","/"+account+"/"));assert.equal(result.configuration_status,undefined);
  assert.equal(hydrate({providers:[{...route,alive:false}]}).providers[0].alive,false,"configured account never revives disabled provider");
 }
});

test("explicit Cloudflare account and custom gateway URLs are never switched by environment",t=>{
 setAccount(t,"fedcba9876543210fedcba9876543210");
 const explicit=placeholder.replace("/me/","/"+account+"/");
 for(const url of [explicit,"https://gateway.example/cloudflare.com/accounts/me/ai/v1/chat/completions","https://gateway.ai.cloudflare.com/v1/custom-gateway"]) {
  assert.equal(providers.resolveUrl(url),url);
  const result=providers.hydrateProvidersFile({providers:[{...route,url}]}).providers[0];assert.equal(result.alive,true);assert.equal(result.url,url);
 }
 delete process.env.CLOUDFLARE_ACCOUNT_ID;
 assert.equal(providers.hydrateProvidersFile({providers:[{...route,url:explicit}]}).providers[0].alive,true);
});

test("runtime skips missing-account Cloudflare before dispatch and fails closed when it is the only route",async t=>{
 setAccount(t,undefined);
 const healthy={name:"Healthy-Codex",family:"codex",protocol:"openai",model:"codex/fixture",upstream_model:"fixture",url:"https://fixture.invalid/v1/chat/completions",default_key:"fixture",caps:["text"],context:10000};
 const hydrated=providers.hydrateProvidersFile({providers:[route,healthy]}).providers;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cloudflare-config-"));const runtime=createTaskRuntime({dataDir:dir,getProviders:()=>hydrated,compression:false});
 t.after(()=>{runtime.close();fs.rmSync(dir,{recursive:true,force:true});});
 let dispatches=0;
 await runtime.handle({model:route.model,messages:[{role:"user",content:"Reply OK."}]},{setHeader(){}},{headers:{"x-llm-proxy-client-id":"fixture","x-llm-proxy-task-id":"missing-account"}},async body=>{
  const chosen=await runtime.beforeDispatch(hydrated[0],body);dispatches++;assert.equal(chosen.name,healthy.name);runtime.recordSuccess(chosen);return "OK";
 });
 assert.equal(dispatches,1);
 const onlyDir=fs.mkdtempSync(path.join(os.tmpdir(),"cloudflare-only-"));const only=createTaskRuntime({dataDir:onlyDir,getProviders:()=>[hydrated[0]],compression:false});t.after(()=>{only.close();fs.rmSync(onlyDir,{recursive:true,force:true});});
 await assert.rejects(()=>only.handle({model:route.model,messages:[{role:"user",content:"Reply OK."}]},{setHeader(){}},{headers:{"x-llm-proxy-client-id":"fixture","x-llm-proxy-task-id":"only-missing-account"}},async body=>{await only.beforeDispatch(hydrated[0],body);assert.fail("unconfigured route must never dispatch");}),/No eligible|No compatible|unavailable|eligible|fit/i);
});
