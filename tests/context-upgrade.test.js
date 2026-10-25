const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {createTaskRuntime} = require("../lib/task-runtime");
const small = {name:"Small", family:"fixture", model:"fixture/small", key:"test", context:20000, caps:["tools","text"]};
const large = {...small,name:"Large",model:"fixture/large",context:100000};
const options={headers:{"x-llm-proxy-task-id":"context-test","x-llm-proxy-client-id":"fixture"}};
function fixture(routes=[small,large], extra={}) { return createTaskRuntime({dataDir:fs.mkdtempSync(path.join(os.tmpdir(),"context-upgrade-")),getProviders:()=>routes,compression:false,...extra}); }
function body(input=1000){return {model:small.model,_inputTokens:input,max_tokens:128000,messages:[{role:"user",content:"Keep exact 731"}],tools:[{type:"function",function:{name:"read",parameters:{type:"object"}}}]};}
test("effective learned capacity and bounded output headroom upgrade pinned continuation",async()=>{
 let learned=20000; const rt=fixture(undefined,{getEffectiveContext:p=>p.name===small.name?learned:p.context});
 try {await rt.handle(body(),null,options,async b=>assert.equal((await rt.beforeDispatch(small,b)).name,"Small")); learned=5000;
 await rt.handle(body(6000),null,options,async b=>assert.equal((await rt.beforeDispatch(small,b)).name,"Large"));}finally{rt.close();}
});
test("trusted overflow excludes smaller peers without changing full messages or tools",async()=>{
 const rt=fixture();try{await rt.handle(body(),null,options,async b=>{
 await rt.beforeDispatch(small,b);const original=JSON.stringify([b.messages,b.tools]);
 rt.requireContextUpgrade(small,b);assert.equal((await rt.beforeDispatch(small,b)).name,"Large");assert.equal(JSON.stringify([b.messages,b.tools]),original);
 });}finally{rt.close();}
});
test("no eligible larger capacity fails once rather than resetting the task or compacting",async()=>{
 const rt=fixture([small]);try{await rt.handle(body(),null,options,async b=>{
 await rt.beforeDispatch(small,b);rt.requireContextUpgrade(small,b);
 await assert.rejects(rt.beforeDispatch(small,b),e=>e.code==="NO_ELIGIBLE_ROUTE");assert.equal(rt.inspectTask().modelHistory.length,1);
 });}finally{rt.close();}
});
test("external body context flags cannot force a model switch",async()=>{
 const rt=fixture();try{await rt.handle({...body(),_contextUpgrade:{minContext:999999},_llmProxyContextUpgrade:999999},null,options,async b=>assert.equal((await rt.beforeDispatch(small,b)).name,"Small"));}finally{rt.close();}
});

test("real proxy retries full request on larger context and terminates exhausted overflow with 422", {timeout:15000},async t=>{
 const http=require("node:http"),{spawn}=require("node:child_process");const calls=[];let exhausted=false;
 const upstream=http.createServer(async(req,res)=>{let raw="";for await(const c of req)raw+=c;const b=JSON.parse(raw);calls.push(b);
 if(b.model==="small"||exhausted){res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{message:"maximum context length exceeded"}}));return;}
 res.setHeader("Content-Type","application/json");res.end(JSON.stringify({id:"context-ok",choices:[{index:0,message:{role:"assistant",content:"The complete request was processed successfully."},finish_reason:"stop"}]}));});
 await new Promise(r=>upstream.listen(0,"127.0.0.1",r));t.after(()=>{upstream.closeAllConnections();upstream.close();});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"context-proxy-"));const base={url:`http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,family:"codex",protocol:"openai",key_env:"FIXTURE_KEY",caps:["text","tools"],tier:2,alive:true};
 const providers=[{...base,name:"Small",model:"codex/small",upstream_model:"small",context:20000},{...base,name:"Large",model:"codex/large",upstream_model:"large",context:100000}];fs.writeFileSync(path.join(dir,"providers.json"),JSON.stringify({providers,groups:{"auto-text":"text"}}));
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,"127.0.0.1",r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const child=spawn(process.execPath,["llm-proxy.js"],{cwd:path.join(__dirname,".."),env:{...process.env,DATA_DIR:dir,LLM_PROXY_PORT:String(port),FIXTURE_KEY:"fixture",MEMORY_ENABLED:"false",DEV_MODE:"false",LLM_PROXY_PROBE_ENABLED:"false"},stdio:["ignore","pipe","pipe"]});let logs="";child.stdout.on("data",c=>logs+=c);child.stderr.on("data",c=>logs+=c);
 t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(r=>child.once("exit",r));}fs.rmSync(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,25));}assert.ok(ready,logs);
 const request={model:"codex/small",max_tokens:128,messages:[{role:"user",content:"Explain the exact marker 731 with full context."}],tools:[{type:"function",function:{name:"read",parameters:{type:"object",properties:{path:{type:"string"}}}}}]};
 const send=id=>fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json","x-llm-proxy-task-id":id},body:JSON.stringify(request)});
 const ok=await send("context-success");assert.equal(ok.status,200,await ok.text()+logs);assert.deepEqual(calls.map(c=>c.model),["small","large"]);assert.deepEqual(calls[0].messages,calls[1].messages);assert.deepEqual(calls[0].tools,calls[1].tools);
 exhausted=true;const before=calls.length;const fail=await send("context-exhausted");const error=await fail.json();assert.equal(fail.status,422,JSON.stringify(error)+logs);assert.equal(error.error.code,"CONTEXT_UPGRADE_UNAVAILABLE");assert.deepEqual(calls.slice(before).map(c=>c.model),["small","large"]);assert.doesNotMatch(logs,/EMERGENCY-COMPACT|MID-COMPACT/);
});

test("context upgrade cannot allocate a fourth distinct model",async()=>{
 const routes=[small,...[1,2,3].map(i=>({...large,name:"Large"+i,model:"fixture/large"+i,context:100000*i}))];const rt=fixture(routes);
 try{await rt.handle(body(),null,options,async b=>{let selected=await rt.beforeDispatch(small,b);for(let i=0;i<2;i++){rt.requireContextUpgrade(selected,b);selected=await rt.beforeDispatch(selected,b);}rt.requireContextUpgrade(selected,b);await assert.rejects(rt.beforeDispatch(selected,b),e=>e.code==="TASK_MODEL_BUDGET_EXHAUSTED");assert.equal(rt.inspectTask().modelHistory.length,3);});}finally{rt.close();}
});
test("larger upgrade respects per-request eligibility and free-only policy",async()=>{
 const free={...small,billing_class:"free_limited"};const paid={...large,billing_class:"paid"};const rt=fixture([free,paid]);
 try{await rt.handle(body(),null,options,async b=>{rt.current().freeOnly=true;await rt.beforeDispatch(free,b);rt.requireContextUpgrade(free,b);await assert.rejects(rt.beforeDispatch(free,b),e=>e.code==="NO_ELIGIBLE_ROUTE");});}finally{rt.close();}
});
