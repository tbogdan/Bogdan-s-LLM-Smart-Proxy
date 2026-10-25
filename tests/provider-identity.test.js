"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const providers=require("../lib/providers");const {createTaskRuntime}=require("../lib/task-runtime");
const base={name:"Shared-Name",family:"codex",protocol:"openai",model:"codex/fixture",upstream_model:"fixture",url:"https://fixture.invalid/v1/chat/completions",default_key:"fixture-a",account_ref:"account-a",caps:["text"],context:10000};
const hydrate=routes=>providers.hydrateProvidersFile({providers:routes}).providers;

test("exact same-name transport identities collapse and any disabled duplicate wins",()=>{
 for(const hydrateFn of [providers.hydrateSeedProviders,providers.hydrateProvidersFile]) {
  for(const states of [[false,true],[true,false],[true,true]]) {
   const result=hydrateFn({providers:[{...base,alive:states[0]},{...base,alive:states[1],context:20000}]}).providers;
   assert.equal(result.length,1);assert.equal(result[0].name,base.name);assert.equal(result[0].alive,states.every(Boolean));assert.equal(result[0].provider_identity_ambiguous,undefined);
  }
 }
});

test("different model, credential, endpoint or declared account identities retain unique stable names",()=>{
 const routes=[base,{...base,model:"codex/other",upstream_model:"other"},{...base,default_key:"fixture-b"},{...base,url:"https://fixture.invalid/other/v1/chat/completions"},{...base,account_ref:"account-b"},{...base,headers:{"x-profile":"different"}}];
 const result=hydrate(routes);assert.equal(result.length,routes.length);assert.ok(result.every(p=>p.name!==base.name));assert.equal(new Set(result.map(p=>p.name)).size,result.length);
 assert.deepEqual(hydrate(routes).map(p=>p.name),result.map(p=>p.name));assert.ok(result.every(p=>p.provider_identity_ambiguous===true && p.provider_identity_stable===true));
 assert.equal(result.filter(p=>p.key==="fixture-a").length,routes.length-1);
 for(const p of result){assert.ok(!p.name.includes("fixture-a"));assert.ok(!p.name.includes("fixture-b"));}
});

test("duplicate credentials with distinct declared account sources keep names through token rotation",()=>{
 const before=hydrate([{...base,account_ref:"one"},{...base,account_ref:"two",default_key:"fixture-b"}]);
 const after=hydrate([{...base,account_ref:"one",default_key:"rotated-a"},{...base,account_ref:"two",default_key:"rotated-b"}]);
 assert.deepEqual(after.map(p=>p.name),before.map(p=>p.name));
});

test("generated duplicate suffix never steals another configured provider name",()=>{
 const pair=[base,{...base,account_ref:"two",default_key:"fixture-b"}];const suffix=hydrate(pair)[1].name;
 const result=hydrate([...pair,{...base,name:suffix,account_ref:"three",default_key:"fixture-c"}]);
 assert.equal(new Set(result.map(p=>p.name)).size,3);assert.notEqual(result[0].name,base.name);assert.equal(result[2].name,suffix);
});

test("different configured names retain separate pins even for identical transport identity",()=>{
 const result=hydrate([base,{...base,name:"Explicit-Alias"}]);assert.equal(result.length,2);assert.deepEqual(result.map(p=>p.name),[base.name,"Explicit-Alias"]);assert.ok(result.every(p=>p.provider_identity_ambiguous===undefined));
});

test("normalized header key order does not create a false distinct transport",()=>{
 const result=hydrate([{...base,headers:{"X-Profile":"same","api-version":"one"}},{...base,headers:{"api-version":"one","x-profile":"same"}}]);
 assert.equal(result.length,1);
});

test("runtime resolves the selected distinct duplicate rather than the first disabled same-name row",async t=>{
 const result=hydrate([{...base,alive:false},{...base,alive:true,account_ref:"account-b",default_key:"fixture-b"}]);
 const selected=result[1];const dir=fs.mkdtempSync(path.join(os.tmpdir(),"provider-identity-"));const runtime=createTaskRuntime({dataDir:dir,getProviders:()=>result,compression:false});t.after(()=>{runtime.close();fs.rmSync(dir,{recursive:true,force:true});});
 await runtime.handle({model:selected.name,messages:[{role:"user",content:"Reply OK."}]},{setHeader(){}},{headers:{"x-llm-proxy-client-id":"fixture","x-llm-proxy-task-id":"distinct-account"}},async body=>{
  const chosen=await runtime.beforeDispatch(selected,body);assert.equal(chosen.name,selected.name);assert.equal(chosen.key,"fixture-b");assert.equal(chosen.alive,true);runtime.recordSuccess(chosen);return "OK";
 });
});


test("ambiguous names bind to the same identity under every input permutation",()=>{
 const routes=[base,{...base,url:"https://second.invalid/v1/chat/completions"},{...base,default_key:"fixture-b"},{...base,account_ref:"account-b",default_key:"fixture-c"},{...base,headers:{Authorization:"Bearer inline-a"}},{...base,headers:{Authorization:"Bearer inline-b"}}];
 const identity=p=>JSON.stringify([p.url,p.key,p.account_ref,p.model,p.headers]);
 const first=new Map(hydrate(routes).map(p=>[identity(p),p.name]));
 for(const ordered of [[...routes].reverse(),[...routes.slice(2),...routes.slice(0,2)]]) {
  const next=hydrate(ordered);assert.ok(next.every(p=>p.name!==base.name));for(const p of next)assert.equal(p.name,first.get(identity(p)));
 }
 assert.equal(new Set(first.values()).size,routes.length);
});

test("persisted runtime pin keeps the actual HTTP endpoint after duplicate rows reverse",async t=>{
 const http=require("node:http");const requests=[];
 const make=async label=>{const server=http.createServer((req,res)=>{requests.push(label);res.end(label);});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});return `http://127.0.0.1:${server.address().port}/v1/chat/completions`;};
 const endpointA=await make("A"),endpointB=await make("B");const raw=[{...base,url:endpointA},{...base,url:endpointB}];
 let current=hydrate(raw);const originalName=current[0].name;const dir=fs.mkdtempSync(path.join(os.tmpdir(),"persisted-provider-identity-"));
 let runtime=createTaskRuntime({dataDir:dir,getProviders:()=>current,compression:false});t.after(()=>{runtime.close();fs.rmSync(dir,{recursive:true,force:true});});
 const run=()=>runtime.handle({model:"auto",messages:[{role:"user",content:"Reply OK."}]},{setHeader(){}},{headers:{"x-llm-proxy-client-id":"fixture","x-llm-proxy-task-id":"pin-endpoint"}},async body=>{
  const selected=await runtime.beforeDispatch(current[0],body);assert.equal(selected.name,originalName);assert.equal(selected.url,endpointA);
  const response=await fetch(selected.url,{method:"POST"});assert.equal(await response.text(),"A");runtime.recordSuccess(selected);return "OK";
 });
 await run();runtime.close();current=hydrate([...raw].reverse());runtime=createTaskRuntime({dataDir:dir,getProviders:()=>current,compression:false});await run();assert.deepEqual(requests,["A","A"]);
});

test("configured identity flags cannot masquerade as computed stable identity",()=>{
 const result=hydrate([{...base,provider_identity_stable:true,provider_identity_ambiguous:true}]);
 assert.equal(result[0].provider_identity_stable,undefined);assert.equal(result[0].provider_identity_ambiguous,undefined);
});


test("same declared key source with different inline credentials or auth headers is order-independent",t=>{
 const keyEnv="IDENTITY_SAME_SOURCE_KEY";const old=process.env[keyEnv];delete process.env[keyEnv];t.after(()=>{if(old===undefined)delete process.env[keyEnv];else process.env[keyEnv]=old;});
 const source={...base,key_env:keyEnv};const routes=[{...source,default_key:"inline-one"},{...source,default_key:"inline-two"},{...source,headers:{Authorization:"Bearer inline-one"}},{...source,headers:{Authorization:"Bearer inline-two"}}];
 const identity=p=>JSON.stringify([p.key,p.headers]);const before=new Map(hydrate(routes).map(p=>[identity(p),p.name]));
 assert.equal(before.size,4);assert.equal(new Set(before.values()).size,4);
 for(const route of hydrate([...routes].reverse())){assert.notEqual(route.name,base.name);assert.equal(route.name,before.get(identity(route)));assert.equal(route.provider_identity_stable,true);}
});
