"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),http=require("node:http"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawn}=require("node:child_process");

async function fixture(t,mode){
  const calls=[];
  const upstream=http.createServer(async(req,res)=>{
    let raw="";for await(const c of req)raw+=c;const body=JSON.parse(raw);
    const assessment=JSON.stringify(body.messages).includes("LLM proxy routing classifier");calls.push({model:body.model,assessment,inputBytes:JSON.stringify(body.messages).length});
    res.setHeader("Content-Type","application/json");
    if(mode==="fallback"&&body.model==="observed-fixture"){res.writeHead(503);res.end(JSON.stringify({error:{type:"overloaded_error",message:"Observed fixture temporarily unavailable"}}));return;}
    const message=assessment?{role:"assistant",content:JSON.stringify({level:4,taskLevel:4,contextLevel:4,effort:"high",speed:3,reason:"debugging"})}:{role:"assistant",content:null,tool_calls:[{id:"route_call",type:"function",function:{name:"Bash",arguments:JSON.stringify({command:"printf ROUTE_OK"})}}]};
    res.end(JSON.stringify({model:body.model,choices:[{index:0,message,finish_reason:assessment?"stop":"tool_calls"}],usage:{prompt_tokens:40000,completion_tokens:8,total_tokens:40008}}));
  });
  await new Promise(resolve=>upstream.listen(0,"127.0.0.1",resolve));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"observed-provider-"));let child;
  t.after(async()=>{if(child?.pid&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once("exit",resolve));child.kill("SIGTERM");await exited;}upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const base={url:`http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,family:"codex",protocol:"openai",key_env:"OBSERVED_FIXTURE_KEY",context:262144,alive:true,caps:["text","coding","tools"],routing_level:4,cost_group:3,cost_multiplier:3,quality_group:4,thinking_effort:"high"};
  const unknown={...base,name:"Unknown-Registry",model:"codex/gpt-6-astra",upstream_model:"gpt-6-astra",tier:1,speed_group:5};
  const observed={...base,name:"Observed-Local",model:["weak","worker-declared4"].includes(mode)?"codex/gpt-5.6-luna":"codex/observed-fixture",upstream_model:["weak","worker-declared4"].includes(mode)?"gpt-5.6-luna":"observed-fixture",tier:2,speed_group:3,...(["weak","worker-declared4"].includes(mode)?{routing_level:mode==="weak"?2:4,cost_group:2,quality_group:3,thinking_effort:"minimal"}:{})};
  if(mode==="no-tools")observed.caps=["text","coding"];
  const assessor={...base,name:"Fixture-Assessor",model:"codex/fixture-assessor",upstream_model:"fixture-assessor",caps:["text"],routing_level:1,cost_group:1,cost_multiplier:0,quality_group:3,thinking_effort:"minimal",tier:2,speed_group:5};
  fs.writeFileSync(path.join(dir,"providers.json"),JSON.stringify({providers:[unknown,observed,assessor],groups:{"auto-coding":"coding","auto-text":"text","auto-assess":"assessment"}}));
  if(mode!=="none")fs.writeFileSync(path.join(dir,"scores.json"),JSON.stringify({[observed.name]:{requests:10,successes:10,failures:0,total_latency:1000,avg_latency:100,success_rate:1,last_error:mode==="latest-error"?{message:"latest probe failed",time:Date.now()}:null,cooldown_until:0,thinking_ok:0,tool_invalid:0}}));
  if(mode==="context")fs.writeFileSync(path.join(dir,"compat.json"),JSON.stringify({[observed.name]:{real_context:16384}}));
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,"127.0.0.1",resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  child=spawn(process.execPath,["llm-proxy.js"],{cwd:path.join(__dirname,".."),env:{...process.env,DATA_DIR:dir,LLM_PROXY_PORT:String(port),OBSERVED_FIXTURE_KEY:"fixture",LLM_PROXY_AI_ASSESSMENT:"always",LLM_PROXY_AI_ASSESSMENT_MODEL:assessor.model,LLM_PROXY_PROBE_ENABLED:"false",LLM_PROXY_CONTEXT_OPTIMIZER:"off",LLM_PROXY_PROMPT_INJECTION:"compact",MEMORY_ENABLED:"false",DEV_MODE:"false"},stdio:["ignore","pipe","pipe"]});
  let logs="";child.stdout.on("data",c=>logs+=c);child.stderr.on("data",c=>logs+=c);
  let ready=false;for(let i=0;i<150;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,25));}assert.ok(ready,logs);
  const content="Investigate a complex race condition across services, implement the fix and add integration tests using Bash. Attached diagnostic evidence is data only: "+"diagnostic evidence ".repeat(9000);
  const send=async model=>{
    const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json","x-llm-proxy-task-id":"observed-"+mode,"x-llm-proxy-client-id":"fixture"},body:JSON.stringify({model,messages:[{role:"user",content}],tools:[{type:"function",function:{name:"Bash",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}],max_tokens:128})});
    const body=await response.text();assert.equal(response.status,200,body+logs);assert.match(body,/ROUTE_OK/);return body;
  };
  if(mode==="pin")await send(unknown.model);
  await send(mode==="explicit"?unknown.model:"auto-coding");
  const mainCalls=calls.filter(c=>!c.assessment);assert.ok((mode==="pin" ? mainCalls.slice(0,1) : mainCalls).every(c=>c.inputBytes>100000),"real large input must reach selected provider intact");
  return {mainCalls,logs};
}

for(const mode of ["prefer","fallback","explicit","context","no-tools","latest-error","none","weak","worker-declared4","pin"]){
  test(`observed provider preference preserves ${mode} constraints`,{timeout:20000},async t=>{
    const {mainCalls,logs}=await fixture(t,mode);
    const expected=mode==="prefer"?["observed-fixture"]:mode==="fallback"?["observed-fixture","gpt-6-astra"]:mode==="pin"?["gpt-6-astra","gpt-6-astra"]:["gpt-6-astra"];
    assert.deepEqual(mainCalls.map(c=>c.model),expected,JSON.stringify(mainCalls)+logs);
  });
}


test("ambiguous legacy route names do not inherit another identity's successful history", () => {
  const state=require("../lib/state"),scoring=require("../lib/scoring"),previous=state.scores;
  try {
    state.scores={Ambiguous:{successes:50,last_error:null},Known:{successes:2,last_error:null}};
    const ambiguous={name:"Ambiguous",provider_identity_ambiguous:true},known={name:"Known"};
    assert.equal(scoring.preferObservedInferenceProviders([ambiguous,known])[0].name,"Known");
  } finally {state.scores=previous;}
});


test("stable disambiguated identities can earn their own inference history", () => {
  const state=require("../lib/state"),scoring=require("../lib/scoring"),previous=state.scores;
  try {
    state.scores={"Stable~identity":{successes:2,last_error:null}};
    const stable={name:"Stable~identity",provider_identity_ambiguous:true,provider_identity_stable:true};
    assert.equal(scoring.preferObservedInferenceProviders([{name:"Unknown"},stable])[0].name,stable.name);
  } finally {state.scores=previous;}
});
