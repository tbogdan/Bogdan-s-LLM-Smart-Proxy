const test=require('node:test'),assert=require('node:assert/strict');
const recovery=require('../lib/tool-choice-recovery');
const body={tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}],tool_choice:{type:'function',function:{name:'read'}}};
const error={status:400,body:JSON.stringify({error:{param:'tool_choice',type:'invalid_request_error',message:'Only auto is supported for tool_choice'}})};
test('tool recovery internal marker never reaches a normal OpenAI-compatible upstream',()=>{
 const adapter=require('../lib/provider-adapters');
 const outbound=adapter.prepareOpenAICompatibleRequest({family:'openai',protocol:'openai',upstream_model:'fixture'},{...body,_llmProxyPreserveToolChoice:true,messages:[{role:'user',content:'Read fixture'}]},false);
 assert.ok(!JSON.stringify(outbound).includes('_llmProxyPreserveToolChoice'));
 assert.deepEqual(outbound.tool_choice,{type:'function',function:{name:'read'}});
});
test('tool errors recover once before client output without changing original request',()=>{
 assert.equal(recovery.shouldRecover(error,body),true);
 assert.equal(recovery.shouldRecover(error,body,{headersSent:true}),false);
 assert.equal(recovery.shouldRecover(error,{...body,tool_choice:'auto'}),false);
 assert.equal(recovery.shouldRecover({...error,status:429},body),false);
 assert.equal(recovery.shouldRecover({status:400,body:JSON.stringify({request:{message:'tool_choice unsupported'},error:{message:'invalid input'}})},body),false);
 assert.equal(recovery.shouldRecover({status:422,body:JSON.stringify({error:{param:'tools.0.function.parameters',message:'Invalid tool schema'}})},body),true);
 assert.equal(recovery.shouldRecover({status:400,body:JSON.stringify({error:{message:'Tools are not supported with this setting'}})},body),true);
 const next=recovery.request(body);assert.equal(next.tool_choice,'auto');assert.equal(next.stream,false);assert.equal(body.tool_choice.function.name,'read');assert.deepEqual(next.tools,body.tools);
});
test('automatic recovery must still satisfy required, named and none controls',()=>{
 const response=calls=>({status:200,body:JSON.stringify({choices:[{message:{role:'assistant',content:'OK',...(calls?{tool_calls:calls}:{})}}]})});
 const read=[{id:'c1',type:'function',function:{name:'read',arguments:'{}'}}];
 assert.doesNotThrow(()=>recovery.validate(response(read),body));
 assert.throws(()=>recovery.validate(response(),body),e=>JSON.parse(e.body).error.code==='unsupported_tool_choice');
 assert.throws(()=>recovery.validate(response([{...read[0],function:{name:'shell',arguments:'{}'}}]),body));
 assert.doesNotThrow(()=>recovery.validate(response(read),{...body,tool_choice:'required'}));
 assert.throws(()=>recovery.validate(response(),{...body,tool_choice:'required'}));
 assert.doesNotThrow(()=>recovery.validate(response(),{...body,tool_choice:'none'}));
 assert.throws(()=>recovery.validate(response(read),{...body,tool_choice:'none'}));
});

test('real proxy recovers named tools for HTTP and SSE, rejects wrong output and leaves auto requests usable',{timeout:30000},async t=>{
 const http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
 const calls=[],listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
 const upstream=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw);calls.push({body:b,session:req.headers['x-opencode-session']});
  res.setHeader('content-type','application/json');
  if(b.tool_choice!=='auto'){res.writeHead(400);res.end(JSON.stringify({error:{param:'tool_choice',message:'Only auto is supported for tool_choice',type:'invalid_request_error'}}));return;}
  const text=b.messages.find(m=>m.role==='user')?.content||'';
  const toolCalls=/wrong|none/.test(text)?[]:[{id:'read1',type:'function',function:{name:'read',arguments:/bad arguments/.test(text)?'{}':'{"path":"fixture.txt"}'}}];
  if(/parallel/.test(text))toolCalls.push({...toolCalls[0],id:'read2'});
  res.end(JSON.stringify({id:'fixture',choices:[{index:0,message:{role:'assistant',content:toolCalls.length?null:'fixture-secret',...(toolCalls.length?{tool_calls:toolCalls}:{})},finish_reason:toolCalls.length?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}}));
 });await listen(upstream);
 t.after(async()=>{upstream.closeAllConnections();await new Promise(r=>upstream.close(r));});
 const allocator=http.createServer();await listen(allocator);const port=allocator.address().port;await new Promise(r=>allocator.close(r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tool-recovery-e2e-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'providers.json'),JSON.stringify({providers:[{name:'Muse-fixture',family:'opencode',protocol:'openai',model:'opencode/muse-spark-1.3-contributor-free',upstream_model:'muse-spark-1.3-contributor-free',url:'http://127.0.0.1:'+upstream.address().port+'/v1/chat/completions',key_env:'FIXTURE_KEY',billing_class:'free_limited',billing_basis:'api',caps:['text','tools'],alive:true,tier:2,context:100000}]}));
 let logs='';const child=spawn(process.execPath,['llm-proxy.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,LLM_PROXY_PORT:String(port),FIXTURE_KEY:'fixture',DEV_MODE:'false',MEMORY_ENABLED:'false',LLM_PROXY_PROBE_ENABLED:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 t.after(async()=>{if(child.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill('SIGTERM');});});
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch('http://127.0.0.1:'+port+'/health')).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,25));}assert.ok(ready,logs);
 const tools=[{type:'function',function:{name:'read',description:'Read fixture file.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}];
 async function send(prompt,choice,stream=false){const r=await fetch('http://127.0.0.1:'+port+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json','x-llm-proxy-task-id':prompt+'-'+stream,'x-llm-proxy-client-id':'tool-test'},body:JSON.stringify({model:'opencode/muse-spark-1.3-contributor-free',messages:[{role:'user',content:prompt}],tools,tool_choice:choice,max_tokens:64,stream}),signal:AbortSignal.timeout(5000)});return{status:r.status,text:await r.text()};}
 for(const stream of [false,true]){const start=calls.length,r=await send('read fixture',body.tool_choice,stream);assert.equal(r.status,200,r.text+'\n'+logs);assert.match(r.text,/read1/);if(stream)assert.match(r.text,/\[DONE\]/);assert.equal(calls.length-start,2);assert.equal(calls[start].session,calls[start+1].session);assert.deepEqual(calls[start].body.tool_choice,{type:'function',function:{name:'read'}});assert.equal(calls[start+1].body.tool_choice,'auto');}
 const parallel=await send('parallel read','required',true);assert.equal(parallel.status,200,parallel.text);
 const collected=require('../scripts/benchmark-opencode-free').collectSse([parallel.text]);
 assert.deepEqual(collected.choices[0].message.tool_calls.map(c=>({id:c.id,name:c.function.name,args:c.function.arguments})),[{id:'read1',name:'read',args:'{"path":"fixture.txt"}'},{id:'read2',name:'read',args:'{"path":"fixture.txt"}'}]);
 const bad=await send('wrong output',body.tool_choice);assert.equal(bad.status,422,bad.text);assert.ok(!bad.text.includes('fixture-secret'));
 const auto=await send('read after failure','auto');assert.equal(auto.status,200,auto.text);
 const none=await send('none allowed','none');assert.equal(none.status,200,none.text);assert.ok(!JSON.parse(none.text).choices[0].message.tool_calls?.length);
 const malformed=await send('bad arguments',body.tool_choice);assert.equal(malformed.status,422,malformed.text);
 const {digest}=require('../lib/task-store'),{resolveTaskIdentity}=require('../lib/task-routing');
 const key=resolveTaskIdentity({clientScope:digest(JSON.stringify(['','tool-test'])),taskId:'bad arguments-false'}).key;
 const record=JSON.parse(fs.readFileSync(path.join(dir,'tasks',digest(key)+'.json')));
 assert.equal(record.usage?.observedDispatches,1);assert.equal(record.usage.inputTokens,10);assert.equal(record.usage.outputTokens,3);
});
