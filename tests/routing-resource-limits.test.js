"use strict";
process.env.LLM_PROXY_MAX_STREAM_BUFFER_BYTES="4096";
process.env.LLM_PROXY_MAX_RETAINED_UPSTREAM_BYTES="16384";
const test=require("node:test"), assert=require("node:assert/strict"), http=require("node:http");
const {EventEmitter,once}=require("node:events");
const fs=require("node:fs");const originalWrite=fs.writeFileSync;test.before(()=>{fs.writeFileSync=()=>{};});test.after(()=>{fs.writeFileSync=originalWrite;});
const routing=require("../lib/routing"), transport=require("../lib/http-transport"), scoring=require("../lib/scoring"), context=require("../lib/task-context");
class Client extends EventEmitter {
  constructor(){super();this.headersSent=false;this.output="";}
  writeHead(){this.headersSent=true;}
  write(c){this.output+=c;return true;}
  end(c){if(c)this.write(c);this.writableEnded=true;this.emit("finish");}
  destroy(){this.destroyed=true;this.emit("close");}
}
const body=()=>({model:"auto-coding",stream:true,messages:[{role:"user",content:"Edit the file /tmp/example.txt using the edit tool."}],tools:[{type:"function",function:{name:"edit",parameters:{type:"object"}}}]});
const provider=url=>({name:"Resource-Test",model:"stream-model",url,key:"test",protocol:"openai",caps:["tools","coding"],context:131072,tier:1});
async function server(t,handler){const s=http.createServer(handler);s.listen(0,"127.0.0.1");await once(s,"listening");t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}`;}
for(const kind of ["partial frame","unterminated tool arguments"]){
 test(`routing bounds ${kind} before client output`,async t=>{
   let closed;const cancelled=new Promise(r=>closed=r);
   const url=await server(t,(req,res)=>{req.on("close",closed);res.writeHead(200,{"content-type":"text/event-stream"});
    res.write(kind==="partial frame" ? "data: "+"x".repeat(600) : Array.from({length:8},()=>`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:"tool",type:"function",function:{name:"edit",arguments:"x".repeat(50)}}]}}]})}\n\n`).join(""));
   });
   const client=new Client();t.after(()=>client.destroy());
   await assert.rejects(routing.routeStreamToProvider(provider(url),body(),client),e=>(e.code||e.error?.code)==="UPSTREAM_RESPONSE_TOO_LARGE");
   await cancelled;assert.equal(client.output,"");client.destroy();assert.equal(transport.stats().retainedBytes,0);
 });
}
test("aggregate overload does not penalize provider or ask task runtime for retry",async t=>{
 const hold=transport.budget.lease(16384);hold.retain(16384);t.after(()=>hold.release());
 const url=await server(t,(_,res)=>res.end("data: {}\n\n"));const p=provider(url),client=new Client();t.after(()=>client.destroy());
 let failures=0,retries=0;const original=scoring.recordFailure;scoring.recordFailure=()=>{failures++;};t.after(()=>scoring.recordFailure=original);
 const runtime={beforeDispatch:async()=>p,recordFailure:async()=>{failures++;},retryable:()=>{retries++;return true;}};
 await assert.rejects(context.run({runtime,identity:{key:"resource-fixture"}},()=>routing.routeStreamToProvider(p,body(),client)),{code:"UPSTREAM_RETAINED_OVERLOADED",statusCode:503});
 assert.equal(failures,0);assert.equal(retries,0);assert.equal(client.output,"");client.destroy();hold.release();assert.equal(transport.stats().retainedBytes,0);
});
test.after(()=>transport.close());

test("tool arguments accumulated across separate frames hit the shared stream ceiling",async t=>{
 let closed;const cancelled=new Promise(r=>closed=r);
 const url=await server(t,(req,res)=>{
  let i=0;const timer=setInterval(()=>{
   const call=i++===0?{index:0,id:"call_a",type:"function",function:{name:"edit",arguments:'{"value":"'}}:{index:0,function:{arguments:"x".repeat(60)}};
   res.write(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[call]}}]})}\n\n`);
  },5);req.on("close",()=>{clearInterval(timer);closed();});
 });
 const client=new Client();t.after(()=>client.destroy());
 await assert.rejects(routing.routeStreamToProvider(provider(url),body(),client),e=>(e.code||e.error?.code)==="UPSTREAM_RESPONSE_TOO_LARGE");
 await cancelled;assert.equal(client.output,"");client.destroy();assert.equal(transport.stats().retainedBytes,0);
});
for (const mode of ["completed payload", "overflow", "disconnect"]) {
 test(`native HTTP2 ${mode} keeps bounded ownership and cancels cleanly`,async t=>{
  const h2=require("node:http2"), cloud=require("../lib/windsurf-cloud");
  const srv=h2.createServer();const sessions=new Set();srv.on("session",s=>{sessions.add(s);s.on("close",()=>sessions.delete(s));});
  let observed;const started=new Promise(r=>observed=r);
  srv.on("stream",s=>{s.on("error",()=>{});s.respond({":status":200});s.write(mode==="overflow"?Buffer.alloc(600):Buffer.from("abcd"));observed();if(mode!=="disconnect")s.end();});
  srv.listen(0,"127.0.0.1");await once(srv,"listening");t.after(()=>{for(const s of sessions)s.destroy();srv.close();});
  const original=transport.config.maxResponseBytes;transport.config.maxResponseBytes=512;t.after(()=>transport.config.maxResponseBytes=original);
  const client=new Client();t.after(()=>client.destroy());
  const call=()=>cloud.postModelConfigProto({origin:`http://127.0.0.1:${srv.address().port}`,path:"/fixture"},Buffer.from("request"));
  if(mode==="completed payload") {const result=await call();assert.equal(result.body.toString(),"abcd");assert.equal(transport.stats().retainedBytes,32);result.release();}
  else if(mode==="overflow")await assert.rejects(call(),{code:"UPSTREAM_RESPONSE_TOO_LARGE"});
  else {const pending=transport.withOwnership(call,client);await started;client.destroy();await assert.rejects(pending,{code:"UPSTREAM_CLIENT_ABORTED"});}
  assert.equal(transport.stats().retainedBytes,0);assert.equal(transport.stats().nativeActive,0);
 });
}

test("native buffered local overload preserves local classification through adapter",async t=>{
 const hold=transport.budget.lease(16384);hold.retain(16384);t.after(()=>hold.release());
 const url=await server(t,(_,res)=>res.end('{"output":"hello"}'));
 await assert.rejects(require("../lib/provider-adapters").routeNonStreaming({...provider(url),protocol:"windsurf"},{messages:[]},()=>assert.fail()),{code:"UPSTREAM_RETAINED_OVERLOADED",localOverload:true,statusCode:503});
 hold.release();assert.equal(transport.stats().retainedBytes,0);
});
test("native fetch partial frame is bounded and upstream is cancelled",async t=>{
 const url=await server(t,(req,res)=>{res.writeHead(200,{"content-type":"text/event-stream"});res.write("data: "+"x".repeat(600));});
 const p={family:"opencode",name:"OpenCode-Test",model:"test",upstream_model:"test",protocol:"openai",url,key:"fixture",access_policy:"public"};
 await assert.rejects(context.run({identity:{key:"resource-fixture"}},()=>require("../lib/opencode-transport").route(p,{messages:[]},{handlers:{onChunk:()=>assert.fail()}})),{code:"UPSTREAM_RESPONSE_TOO_LARGE"});
 assert.equal(transport.stats().retainedBytes,0);assert.equal(transport.stats().nativeActive,0);
});

test("aggregate pressure after visible output terminates without retry or provider penalty",async t=>{
 const cap=transport.config.maxStreamBytes;transport.config.maxStreamBytes=32768;t.after(()=>transport.config.maxStreamBytes=cap);
 let closed;const cancelled=new Promise(r=>closed=r);
 const url=await server(t,(req,res)=>{let i=0;const timer=setInterval(()=>res.write(`data: ${JSON.stringify({choices:[{delta:{content:`A clear explanation step ${i++}. `}}]})}\n\n`),5);req.on("close",()=>{clearInterval(timer);closed();});});
 const client=new Client(),hold=transport.budget.lease(16384);t.after(()=>{client.destroy();hold.release();});
 const write=client.write.bind(client);let reserved=false;client.write=c=>{write(c);if(!reserved){reserved=true;hold.retain(16384-transport.stats().retainedBytes);}return true;};
 let failures=0,retries=0;const original=scoring.recordFailure;scoring.recordFailure=()=>{failures++;};t.after(()=>scoring.recordFailure=original);
 const p=provider(url),runtime={beforeDispatch:async()=>p,recordFailure:async()=>{failures++;},retryable:()=>{retries++;return true;}};
 await assert.rejects(context.run({runtime,identity:{key:"resource-fixture"}},()=>routing.routeStreamToProvider(p,{model:"auto",stream:true,messages:[{role:"user",content:"Explain why the sky is blue."}]},client)),e=>e.code==="UPSTREAM_RETAINED_OVERLOADED"&&e.headersSent===true);
 await cancelled;assert.ok(client.output.length>0);assert.equal(client.destroyed,true);assert.equal(failures,0);assert.equal(retries,0);hold.release();assert.equal(transport.stats().retainedBytes,0);
});

test("routing consumes bounded metadata frames beyond cumulative traffic ceiling",async t=>{
 const limit=transport.config.maxStreamBytes;transport.config.maxStreamBytes=8192;t.after(()=>transport.config.maxStreamBytes=limit);
 let sent=0;
 const url=await server(t,(req,res)=>{
  const timer=setInterval(()=>{
   if(sent++<4)res.write(`data: ${JSON.stringify({choices:[{delta:{content:`Explanation ${sent} is clear. `}}]})}\n\n`);
   else if(sent<80)res.write(`data: ${JSON.stringify({choices:[],padding:"x".repeat(250)})}\n\n`);
   else {clearInterval(timer);res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');}
  },2);res.on("close",()=>clearInterval(timer));
 });
 const client=new Client();t.after(()=>client.destroy());
 const result=await routing.routeStreamToProvider(provider(url),{model:"auto",stream:true,messages:[{role:"user",content:"Explain sky colors."}]},client);
 assert.equal(result.streamed,true);assert.ok(sent>=80);assert.equal(transport.stats().retainedBytes,0);
});
test("Windsurf discovery stops immediately on local capacity failure",async()=>{
 let calls=0;
 await assert.rejects(require("../lib/windsurf-cloud").fetchWindsurfModelConfigs({key:"fixture"},{paths:["/one","/two"],postModelConfigFn:async()=>{calls++;throw transport.boundaryError("UPSTREAM_RETAINED_OVERLOADED",503);}}),{code:"UPSTREAM_RETAINED_OVERLOADED"});
 assert.equal(calls,1);
});
test("routing retains prior full error during delayed retry then discards its lease",async t=>{
 routing.init({sendError:()=>{},trackSessionTokens:()=>{}});
 let finish,started;const secondStarted=new Promise(r=>started=r);const failureBody=JSON.stringify({error:{message:"fixture "+"x".repeat(700)}});
 const url=await server(t,(req,res)=>{if(req.url==="/bad"){res.writeHead(500);res.end(failureBody);}else{finish=()=>res.end(JSON.stringify({choices:[{message:{role:"assistant",content:"The answer is forty two."},finish_reason:"stop"}]}));started();}});
 const first={...provider(url+"/bad"),name:"First-Resource"},second={...provider(url+"/good"),name:"Second-Resource"};let attempts=0,heldError;
 const runtime={beforeDispatch:async()=>attempts++?second:first,recordFailure:async(_p,e)=>{heldError=e;},retryable:()=>true,recordSuccess:()=>{},recordDispatch:async(_p,r)=>r,resolveResponse:async r=>r};
 const pending=context.run({runtime,identity:{key:"retry-resource"}},()=>routing.routeToProvider(first,{model:"fixture",messages:[{role:"user",content:"What is the answer?"}]}));pending.catch(()=>{});
 await secondStarted;assert.equal(heldError.body,failureBody);assert.ok(transport.stats().retainedBytes>=Buffer.byteLength(failureBody)*8);
 finish();const result=await pending;const retained=transport.stats().retainedBytes;
 assert.ok(retained>0);assert.ok(retained<Buffer.byteLength(failureBody)*8,"old error payload must be discarded after successful retry");
 result.release();assert.equal(transport.stats().retainedBytes,0);heldError.release();assert.equal(transport.stats().retainedBytes,0);
});
