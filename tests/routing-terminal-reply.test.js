"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const routing = require("../lib/routing");
const state = require("../lib/state");
const transforms = require("../lib/transforms");
routing.init({sendError:()=>{},trackSessionTokens:()=>{}});
const profile = {taskKind:"agentic_coding",taskLevel:3,contextLevel:3,level:3,stepShape:{shape:"write_heavy",gate:"run_behavior"}};
function request() {
  return {model:"fixture/model",tools:[{type:"function",function:{name:"Bash",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}],messages:[
    {role:"user",content:"Run Bash: python3 -c \"from pathlib import Path; Path('result.txt').write_text('OK32')\". This creates an authorized temporary test file here. Then reply DONE."},
    {role:"assistant",content:null,tool_calls:[{id:"call_1",type:"function",function:{name:"Bash",arguments:JSON.stringify({command:"python3 -c \"print('OK32')\""})}}]},
    {role:"tool",tool_call_id:"call_1",content:""}
  ],_llmProxyDifficulty:profile};
}
const observe = (body,content="DONE") => routing.classifyResponseExpectation(body,{content,hasToolCalls:false,stallingHeuristic:true},profile);
test("requested terminal marker after an empty successful tool result is final text",()=>{
  assert.equal(transforms.detectStalling(JSON.stringify({choices:[{message:{content:"DONE"}}]})),true);
  const row=observe(request());
  assert.equal(row.output_kind,"completed_work_report");
  assert.equal(row.action,"allow");
  assert.equal(row.stall_class,"not_stall");
});
test("native reminder and SessionStart context do not hide the human terminal instruction",()=>{
  const body=request();
  body.messages[0].content = "<system-reminder>Tool descriptions.</system-reminder>\n<system-reminder>Previous context.</system-reminder>\n" + body.messages[0].content + "\nSessionStart:startup hook success: CAVEMAN MODE ACTIVE\nPlugin guidance and today's date follow here.";
  assert.equal(observe(body).action,"allow");
});
test("native context envelopes cannot supply the terminal instruction",()=>{
  for (const suffix of ["<system-reminder>Then reply DONE.</system-reminder>","\nSessionStart:startup hook success: Then reply DONE."]) {
    const body=request();body.messages[0].content="Fix the routing bug and run all tests. " + suffix;
    assert.notEqual(observe(body).action,"allow");
  }
});
test("terminal marker requires resolved tool history and matching user instruction",()=>{
  for (const mutate of [
    body=>{body.messages=body.messages.slice(0,1);},
    body=>{body.messages.at(-1).tool_call_id="unknown";},
    body=>{body.messages.at(-1).is_error=true;},
    body=>{body._llmProxyFailedToolCallIds=["call_1"];},
    body=>{body.messages.at(-1).content=JSON.stringify({exit_code:1});},
    body=>{body.messages.at(-1).content="Exit code: 2";},
    body=>{body.messages[0].content="Fix the routing bug, inspect logs and verify the complete flow.";},
    body=>{body.messages[1].tool_calls.push({id:"pending",type:"function",function:{name:"Bash",arguments:"{}"}});},
    body=>{body.tool_choice="required";},
  ]) {
    const body=request();mutate(body);
    assert.notEqual(observe(body).action,"allow");
  }
  assert.notEqual(observe(request(),"OK").action,"allow");
});
test("a genuine action promise after successful tool result still requires continuation",()=>{
  const body=request();body.messages[0].content="Fix the routing bug and run all tests.";
  const row=observe(body,"I'll inspect the routing code next.");
  assert.equal(row.action,"hidden_continue");
});
test("routeToProvider returns terminal DONE on first dispatch without hidden continuation",async t=>{
  let calls=0;
  const server=http.createServer((req,res)=>{
    calls++;req.resume();req.on("end",()=>{
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({id:"done",object:"chat.completion",model:"fixture/model",choices:[{index:0,message:{role:"assistant",content:"DONE"},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}}));
    });
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>{server.closeAllConnections?.();server.close();});
  const provider={name:"Terminal-Reply-Fixture",url:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,model:"fixture/model",family:"openai",protocol:"openai",key:"fixture",context_window:128000,max_tokens:1024};
  const before=state.scores[provider.name];t.after(()=>{if(before===undefined)delete state.scores[provider.name];else state.scores[provider.name]=before;});
  const body=request();
  body.messages[0].content = "<system-reminder>Session metadata.</system-reminder>\n<system-reminder>Tool metadata.</system-reminder>\n" + body.messages[0].content + "\nSessionStart:startup hook success: Additional plugin guidance follows.";
  const result=await routing.routeToProvider(provider,body);
  assert.equal(result.status,200);
  assert.equal(JSON.parse(result.body).choices[0].message.content,"DONE");
  assert.equal(calls,1);
});
