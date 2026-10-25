"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),http=require("node:http"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawn}=require("node:child_process");

async function fixture(t,mode){
  const calls=[], aborted=[];
  let assessmentStartedResolve;
  const assessmentStarted=new Promise(resolve=>{assessmentStartedResolve=resolve;});
  const upstream=http.createServer(async(req,res)=>{
    let raw="";for await(const c of req)raw+=c;
    const body=JSON.parse(raw),assessment=JSON.stringify(body).includes("LLM proxy routing classifier");calls.push({assessment,model:body.model});if(assessment)assessmentStartedResolve();
    res.setHeader("Content-Type","application/json");
    if(assessment && ["timeout","abort"].includes(mode) && body.model==="assess-0") {
      res.once("close",()=>{if(!res.writableEnded)aborted.push(body.model);});
      setTimeout(()=>{res.writeHead(503);res.end(JSON.stringify({error:{type:"overloaded_error",message:"Late fixture assessor failure"}}));},800);return;
    }
    if(assessment && mode==="terminal") {res.writeHead(400);res.end(JSON.stringify({error:{type:"invalid_request_error",message:"Invalid fixture assessment request ASSESS_PRIVATE_TOKEN"}}));return;}
    if(assessment && mode==="fallback" && body.model==="assess-0") {res.writeHead(503);res.end(JSON.stringify({error:{type:"overloaded_error",message:"Fixture assessor unavailable"}}));return;}
    const message=assessment ? {role:"assistant",content:JSON.stringify({level:3,taskLevel:3,contextLevel:1,effort:"medium",speed:4,reason:"agentic_coding"})} : {role:"assistant",content:null,tool_calls:[{id:"fixture_call",type:"function",function:{name:"Bash",arguments:JSON.stringify({command:"printf PRIMARY_OK"})}}]};
    res.end(JSON.stringify({id:"fixture",model:body.model,choices:[{index:0,message,finish_reason:assessment?"stop":"tool_calls"}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
  });
  await new Promise(resolve=>upstream.listen(0,"127.0.0.1",resolve));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"assessment-terminal-"));let child;
  t.after(async()=>{
    if(child?.pid && child.exitCode===null && child.signalCode===null){const exited=new Promise(resolve=>child.once("exit",resolve));child.kill("SIGTERM");await exited;}
    upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const base={url:`http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,family:"codex",protocol:"openai",key_env:"ASSESSMENT_FIXTURE_KEY",context:131072,alive:true};
  const assessors=Array.from({length:6},(_,i)=>({...base,name:`Assessor-${i}`,model:`codex/assess-${i}`,upstream_model:`assess-${i}`,caps:["text"],tier:2,cost_group:1,cost_multiplier:i,speed_group:5,quality_group:3,thinking_effort:"minimal"}));
  const coder={...base,name:"Primary-Coder",model:"codex/primary-coder",upstream_model:"primary-coder",caps:["text","coding","tools"],tier:3,cost_group:3,speed_group:4,quality_group:4,thinking_effort:"medium"};
  fs.writeFileSync(path.join(dir,"providers.json"),JSON.stringify({providers:[...assessors,coder],groups:{"auto-assess":"assessment","auto-coding":"coding","auto-text":"text"}}));
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,"127.0.0.1",resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  child=spawn(process.execPath,["llm-proxy.js"],{cwd:path.join(__dirname,".."),env:{...process.env,DATA_DIR:dir,LLM_PROXY_PORT:String(port),ASSESSMENT_FIXTURE_KEY:"fixture",LLM_PROXY_AI_ASSESSMENT:"always",LLM_PROXY_AI_ASSESSMENT_MODEL:"auto-assess",LLM_PROXY_AI_ASSESSMENT_MAX_PROVIDERS:"6",LLM_PROXY_AI_ASSESSMENT_TIMEOUT_MS:mode==="abort"?"5000":"500",LLM_PROXY_PROBE_ENABLED:"false",MEMORY_ENABLED:"false",DEV_MODE:"false"},stdio:["ignore","pipe","pipe"]});
  let logs="";child.stdout.on("data",c=>logs+=c);child.stderr.on("data",c=>logs+=c);
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,25));}assert.ok(ready,logs);
  const controller=new AbortController();
  const pending=fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{signal:controller.signal,method:"POST",headers:{"Content-Type":"application/json","x-llm-proxy-task-id":"assessment-"+mode,"x-llm-proxy-client-id":"fixture"},body:JSON.stringify({model:"auto-coding",messages:[{role:"user",content:"Implement the requested code change, inspect the project configuration and verify the tests with Bash."}],tools:[{type:"function",function:{name:"Bash",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}],max_tokens:128})});
  if(mode==="abort"){
    pending.catch(()=>{});
    let readyTimer;
    try { await Promise.race([assessmentStarted,new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(new Error("assessment must start before client cancellation\n"+logs)),10000);})]); }
    catch(error){controller.abort();await pending.catch(()=>{});throw error;}
    finally{clearTimeout(readyTimer);}
    controller.abort();await assert.rejects(pending,{name:"AbortError"});
    await new Promise(resolve=>setTimeout(resolve,150));return {calls,logs,aborted};
  }
  const response=await pending;
  const body=await response.text();assert.equal(response.status,200,body+logs);assert.match(body,/PRIMARY_OK/);
  if(mode==="timeout")await new Promise(resolve=>setTimeout(resolve,900));
  return {calls,logs,aborted};
}

test("terminal assessment 400 is not repeated across pinned candidate routes",{timeout:15000},async t=>{
  const {calls,logs}=await fixture(t,"terminal");
  const assessmentCalls=calls.filter(c=>c.assessment);
  assert.equal(assessmentCalls.length,1,JSON.stringify(calls)+logs);
  assert.equal(calls.filter(c=>!c.assessment).length,1,"normal heuristic-selected primary still serves request");
  assert.doesNotMatch(logs.split("\n").filter(line=>line.includes("AI-ASSESS-SKIP:")).join("\n"),/ASSESS_PRIVATE_TOKEN/,"assessment skip diagnostics must not include upstream payload");
});

test("assessment metadata names the provider that actually served runtime fallback",{timeout:15000},async t=>{
  const {calls,logs}=await fixture(t,"fallback");
  const assessmentCalls=calls.filter(c=>c.assessment);assert.equal(assessmentCalls.length,2,JSON.stringify(calls)+logs);
  assert.equal(assessmentCalls[0].model,"assess-0");
  const actualName="Assessor-"+assessmentCalls[1].model.replace("assess-","");
  assert.match(logs,new RegExp("AI-ASSESS:.*assessor="+actualName+" "),logs);
});


test("assessment deadline cancels its HTTP work and prevents late fallback while primary continues",{timeout:15000},async t=>{
  const {calls,logs,aborted}=await fixture(t,"timeout");
  assert.deepEqual(calls.filter(c=>c.assessment).map(c=>c.model),["assess-0","assess-1"],JSON.stringify(calls)+logs);
  assert.deepEqual(aborted,["assess-0"],"deadline must close the timed-out upstream response");
  assert.equal(calls.filter(c=>!c.assessment).length,1,"parent request remains usable after child deadline");
  assert.match(logs,/timed out after 500ms/);
});


test("client cancellation propagates through assessment without another candidate or primary call",{timeout:15000},async t=>{
  const {calls,logs,aborted}=await fixture(t,"abort");
  assert.deepEqual(calls,[{assessment:true,model:"assess-0"}]);
  assert.deepEqual(aborted,["assess-0"]);
  assert.doesNotMatch(logs,/AI-ASSESS-SKIP:/,"cancelled parent must not continue assessment selection");
});
