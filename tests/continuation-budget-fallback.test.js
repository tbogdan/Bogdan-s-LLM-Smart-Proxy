"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");

for (const budget of [0, 1]) test(`continuation budget ${budget} preserves bounded recovery before output`, {timeout:15000}, async t => {
  let allBad=false, partial=false, preludeAttempts=0;
  const calls=[];
  const upstream=http.createServer(async (req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);calls.push(body.model);
    if(partial && body.model === "prelude") {
      res.setHeader("Content-Type","text/event-stream");
      const content=["The design separates state from transport. ","Bounded queues keep overload predictable. ","Cancellation releases pending resources promptly. "];
      const write=i=>res.write('data: '+JSON.stringify({id:"visible",model:body.model,choices:[{index:0,delta:{content:content[i]},finish_reason:null}]})+'\n\n');
      write(0);setTimeout(()=>write(1),25);setTimeout(()=>write(2),50);
      setTimeout(()=>res.destroy(),100);return;
    }
    if (body.model === "prelude") preludeAttempts++;
    const bad=allBad || (body.model.startsWith("prelude") && !(budget > 0 && preludeAttempts > 1));
    const message=bad ? {role:"assistant",content:"I'll inspect the repository next."} : {role:"assistant",content:null,tool_calls:[{id:"valid_call",type:"function",function:{name:"Bash",arguments:JSON.stringify({command:"printf OK"})}}]};
    const finish=bad?"stop":"tool_calls";
    if(body.stream){
      res.setHeader("Content-Type","text/event-stream");
      const delta={...message};delete delta.role;
      res.end('data: '+JSON.stringify({id:"fixture",model:body.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:"fixture",model:body.model,choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:8,total_tokens:18}})+'\n\ndata: [DONE]\n\n');
    }else{res.setHeader("Content-Type","application/json");res.end(JSON.stringify({id:"fixture",model:body.model,choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:8,total_tokens:18}}));}
  });
  await new Promise(resolve=>upstream.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"prelude-budget-"));
  let child;
  // Test hooks run in registration order. Stop the writer before removing its
  // data directory, including on assertion failure or early test return.
  t.after(async()=>{
    if(child?.pid && child.exitCode===null && child.signalCode===null){
      const exited=new Promise(resolve=>child.once("exit",resolve));
      child.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const base={url:`http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,family:"codex",protocol:"openai",key_env:"FIXTURE_KEY",caps:["text","tools"],context:131072,tier:2,alive:true};
  const providers=[
    {...base,name:"Prelude",model:"codex/prelude",upstream_model:"prelude"},
    {...base,name:"Prelude-Alias",model:"codex/prelude",upstream_model:"prelude"},
    {...base,name:"Healthy",model:"codex/healthy",upstream_model:"healthy"},
    {...base,name:"Third",model:"codex/prelude2",upstream_model:"prelude2"},
    {...base,name:"Fourth",model:"codex/prelude3",upstream_model:"prelude3"}
  ];
  fs.writeFileSync(path.join(dir,"providers.json"),JSON.stringify({providers,groups:{"auto-text":"text"}}));
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,"127.0.0.1",resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  child=spawn(process.execPath,["llm-proxy.js"],{cwd:path.join(__dirname,".."),env:{...process.env,DATA_DIR:dir,LLM_PROXY_PORT:String(port),FIXTURE_KEY:"fixture",LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES:String(budget),MEMORY_ENABLED:"false",DEV_MODE:"false",LLM_PROXY_PROBE_ENABLED:"false"},stdio:["ignore","pipe","pipe"]});
  let logs="";child.stdout.on("data",x=>logs+=x);child.stderr.on("data",x=>logs+=x);
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,25));}assert.ok(ready,logs);
  for(const stream of [false,true]){
    preludeAttempts=0;
    const begin=calls.length;
    const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json","x-llm-proxy-task-id":"prelude-"+stream,"x-llm-proxy-client-id":"fixture"},body:JSON.stringify({model:providers[0].model,stream,max_tokens:128,messages:[{role:"user",content:"Implement a file with Bash and verify it. Use the Bash tool now, do not promise future work."}],tools:[{type:"function",function:{name:"Bash",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}]})});
    const text=await response.text();assert.equal(response.status,200,text+logs);assert.match(text,/printf OK|printf \\"OK/);assert.doesNotMatch(text,/inspect the repository/);
    assert.deepEqual(calls.slice(begin),budget ? ["prelude","prelude"] : ["prelude","healthy"]);
  }
  if(budget){assert.match(logs,/HIDDEN-CONTINUE-RETRY/);assert.doesNotMatch(logs,/OUTPUT-UNUSABLE-FALLBACK/);return;}
  allBad=true;
  const begin=calls.length;
  const exhausted=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json","x-llm-proxy-task-id":"all-unusable","x-llm-proxy-client-id":"fixture"},body:JSON.stringify({model:providers[0].model,max_tokens:128,messages:[{role:"user",content:"Implement a file with Bash and verify it. Use tools now."}],tools:[{type:"function",function:{name:"Bash",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}]})});
  const error=await exhausted.json();assert.equal(exhausted.status,422,JSON.stringify(error)+logs);
  assert.equal(error.error.code,"UPSTREAM_OUTPUT_UNUSABLE");assert.equal(error.error.message,"No eligible model returned usable output");
  assert.deepEqual(calls.slice(begin),["prelude","healthy","prelude2"]);
  allBad=false;partial=true;
  const visibleBegin=calls.length;
  const visible=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json","x-llm-proxy-task-id":"visible-output","x-llm-proxy-client-id":"fixture"},body:JSON.stringify({model:providers[0].model,stream:true,max_tokens:128,messages:[{role:"user",content:"Explain this design in a clear report."}]})});
  assert.equal(visible.status,200);try{await visible.text();}catch{}
  await new Promise(resolve=>setTimeout(resolve,100));assert.deepEqual(calls.slice(visibleBegin),["prelude"],"visible output must never be replayed on another model");
  assert.doesNotMatch(logs,/HIDDEN-CONTINUE-RETRY/);
});


test("unusable output releases a recovered account probe without quarantining credentials", async t => {
  const {createTaskRuntime}=require("../lib/task-runtime");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"prelude-probe-"));
  let now=1000;
  const provider={name:"Recovered",family:"codex",model:"codex/recovered",key:"fixture",context:131072,caps:["text","tools"]};
  const runtime=createTaskRuntime({dataDir:dir,getProviders:()=>[provider],now:()=>now,compression:false});
  t.after(()=>{runtime.close();fs.rmSync(dir,{recursive:true,force:true});});
  runtime.observeProviderFailure(provider,{status:503,body:"temporary upstream outage"});
  now=62000;
  assert.equal(runtime.isProviderAvailable(provider),true);
  await runtime.handle({model:provider.model,messages:[{role:"user",content:"Implement the task using Bash."}]},{setHeader(){}},{headers:{"x-llm-proxy-task-id":"probe","x-llm-proxy-client-id":"fixture"}},async body=>{
    await runtime.beforeDispatch(provider,body);
    assert.equal(runtime.isProviderAvailable(provider),false,"half-open probe is held until completion");
    await runtime.recordFailure(provider,{status:409,hiddenContinuation:true,outputUnusable:true,body:"hidden continuation: action_prelude"});
    assert.equal(runtime.isProviderAvailable(provider),true,"request-local output mismatch must release the account probe");
    return "finished";
  });
});
