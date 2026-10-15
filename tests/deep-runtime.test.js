const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.join(__dirname,'..');
const WS=require(path.join(root,'node_modules/ws'));
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
test('real HTTP protocols, SSE, account failover, WebSocket and restart preserve task allocation',{timeout:25000},async()=>{
 const calls=[];let exhausted=false;let child;let log='';
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);const account=req.headers.authorization;calls.push({b,account});
 if(exhausted&&account==='Bearer fixture-A'){res.writeHead(429,{'Content-Type':'application/json','Retry-After':'3600'});res.end(JSON.stringify({error:{code:'insufficient_quota',message:'Insufficient credits'}}));return;}
 if(b.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:b.model,choices:[{index:0,delta:{role:'assistant',content:'Cache preserved.'},finish_reason:null}]})+'\n\n');res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:b.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})+'\n\ndata: [DONE]\n\n');return;}
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'fixture-'+calls.length,object:'chat.completion',model:b.model,choices:[{index:0,message:{role:'assistant',content:'Cache preserved.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}}));
 });await listen(upstream);const allocator=http.createServer();await listen(allocator);const port=allocator.address().port;await new Promise(r=>allocator.close(r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'deep-proxy-'));
 const providers=[['A','gpt-test','gpt-test'],['B','gpt-backup','gpt-test'],['C','gpt-other','gpt-other']].map(([id,model,upstream_model])=>({name:'Fixture-'+id,family:'openai',protocol:'openai',model:'openai/'+model,upstream_model,key_env:'FIXTURE_'+id,account_ref:id,caps:['text','tools'],context:131072,tier:2,alive:true,url:'http://127.0.0.1:'+upstream.address().port+'/v1/chat/completions'}));
 fs.writeFileSync(path.join(dir,'providers.json'),JSON.stringify({providers,groups:{'auto-text':'text'}}));
 async function start(){child=spawn(process.execPath,['llm-proxy.js'],{cwd:root,env:{...process.env,DATA_DIR:dir,LLM_PROXY_PORT:String(port),FIXTURE_A:'fixture-A',FIXTURE_B:'fixture-B',FIXTURE_C:'fixture-C',MEMORY_ENABLED:'false',DEV_MODE:'false',LLM_PROXY_PROBE_ENABLED:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);for(let i=0;i<80;i++){try{if((await fetch('http://127.0.0.1:'+port+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,25));}throw new Error(log);}
 async function stop(signal='SIGTERM'){const c=child;if(!c||c.exitCode!==null)return;child=null;await new Promise(r=>{c.once('exit',r);c.kill(signal);});}
 async function send(endpoint,body,task='root'){const r=await fetch('http://127.0.0.1:'+port+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-LLM-Proxy-Task-ID':task,'X-LLM-Proxy-Client-ID':'deep-test'},body:JSON.stringify(body)});const text=await r.text();assert.equal(r.status,200,text+'\n'+log);return {r,text};}
 try{await start();const msg=[{role:'user',content:'Explain persistent cache.'}];
 await send('/v1/chat/completions',{model:'openai/gpt-test',messages:msg,max_tokens:32});
 const responses=await send('/v1/responses',{model:'openai/gpt-other',input:'Explain persistent cache.',max_output_tokens:32});assert.ok(JSON.parse(responses.text).id);
 await send('/v1/messages',{model:'openai/gpt-other',messages:msg,max_tokens:32});
 const sse=await send('/v1/chat/completions',{model:'openai/gpt-other',messages:msg,max_tokens:32,stream:true});assert.match(sse.text,/Cache preserved/);assert.match(sse.text,/\[DONE\]/);
 assert.deepEqual(calls.map(x=>x.account),Array(4).fill('Bearer fixture-A'));
 await stop();await start();await send('/v1/chat/completions',{model:'openai/gpt-other',messages:msg,max_tokens:32});assert.equal(calls.at(-1).account,'Bearer fixture-A');
 exhausted=true;const before=calls.length;await send('/v1/chat/completions',{model:'openai/gpt-test',messages:msg,max_tokens:32});assert.deepEqual(calls.slice(before).map(x=>x.account),['Bearer fixture-A','Bearer fixture-B']);assert.equal(calls.at(-1).b.model,'gpt-test');
 await stop('SIGKILL');await start();await send('/v1/chat/completions',{model:'openai/gpt-other',messages:msg,max_tokens:32});assert.equal(calls.at(-1).account,'Bearer fixture-B');
 const ws=new WS('ws://127.0.0.1:'+port+'/v1/responses',{headers:{'X-LLM-Proxy-Client-ID':'deep-ws'}});const events=[];let resolveDone,rejectDone;let done=new Promise((r,j)=>{resolveDone=r;rejectDone=j;});ws.on('error',rejectDone);ws.on('message',raw=>{const e=JSON.parse(raw);events.push(e);if(e.type==='response.completed')resolveDone(e);if(e.type==='error')rejectDone(new Error(JSON.stringify(e)));});await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
 ws.send(JSON.stringify({type:'response.create',response:{model:'openai/gpt-other',input:[{role:'user',content:'Explain websocket task reuse.'}],max_output_tokens:32}}));await done;const last=calls.at(-1).account;
 done=new Promise((r,j)=>{resolveDone=r;rejectDone=j;});ws.send(JSON.stringify({type:'response.create',response:{model:'openai/gpt-backup',input:[{role:'user',content:'Continue.'}],max_output_tokens:32}}));await done;assert.equal(calls.at(-1).account,last);await new Promise(r=>{ws.once('close',r);ws.close();});
 assert.ok(calls.every(x=>!Object.keys(x.b).some(k=>k.startsWith('_llmProxy'))));
 }finally{await stop();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
