"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { createTransport, createRetainedBudget } = require("../lib/http-transport");
async function fixture(t, handler, opts = {}) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const transport = createTransport(opts);
  t.after(() => { transport.close(); server.closeAllConnections(); server.close(); });
  return { transport, server, url: `http://127.0.0.1:${server.address().port}` };
}
test("keepalive reuses a socket and uses separate protocol agents", async t => {
  let sockets = new Set();
  const { transport: x, url } = await fixture(t, (req,res) => { sockets.add(req.socket); res.end("ok"); });
  for(let i=0;i<3;i++){ const r=await x.makeRequest(url,{},null); assert.equal(r.body,"ok"); r.release(); }
  assert.equal(sockets.size,1); assert.notEqual(x.agents.http,x.agents.https);
  assert.equal(x.stats().retainedBytes,0);
});
test("completed response keeps its lease until delayed consumer releases", async t => {
  const { transport:x,url }=await fixture(t, (_,r)=>r.end("1234"), { maxRetainedBytes: 8, representationMultiplier: 1 });
  const a=await x.makeRequest(url,{}), b=await x.makeRequest(url,{});
  assert.equal(x.stats().retainedBytes,8);
  await assert.rejects(x.makeRequest(url,{}), {code:"UPSTREAM_RETAINED_OVERLOADED",statusCode:503});
  assert.equal(x.stats().retainedBytes,8); a.release(); a.release(); b.release();
  assert.equal(x.stats().retainedBytes,0);
});
test("byte cap handles split UTF8 and cleans reservations on overflow", async t => {
  const {transport:x,url}=await fixture(t,(_,r)=>{const b=Buffer.from("€€");r.write(b.subarray(0,2));r.end(b.subarray(2));},{maxResponseBytes:5});
  await assert.rejects(x.makeRequest(url,{}),{code:"UPSTREAM_RESPONSE_TOO_LARGE"});
  assert.equal(x.stats().retainedBytes,0);
});
test("truncated responses reject once and release", async t=>{
  const {transport:x,url}=await fixture(t,(_,r)=>{r.writeHead(200,{"content-length":100});r.write("x");setImmediate(()=>r.destroy());});
  await assert.rejects(x.makeRequest(url,{})); assert.equal(x.stats().retainedBytes,0);
});
test("queued requests have absolute deadline and bounded admission",async t=>{
  const {transport:x,url}=await fixture(t,()=>{}, {maxSockets:1,maxTotalSockets:1,maxRequests:2,timeoutMs:60});
  const a=x.makeRequest(url,{}), b=x.makeRequest(url,{});
  const result=Promise.allSettled([a,b]);
  await assert.rejects(x.makeRequest(url,{}),{code:"UPSTREAM_TRANSPORT_OVERLOADED"});
  assert.deepEqual((await result).map(r=>r.reason.code),["UPSTREAM_TIMEOUT","UPSTREAM_TIMEOUT"]);
  assert.equal(x.stats().inflight,0);
});
test("AbortSignal cancels queued and active requests with custom agent preserved",async t=>{
  const agent=new http.Agent({keepAlive:true,maxSockets:1});t.after(()=>agent.destroy());
  const {transport:x,url}=await fixture(t,()=>{});
  const controller=new AbortController();
  const a=x.makeRequest(url,{agent,signal:controller.signal}), b=x.makeRequest(url,{agent,signal:controller.signal});
  const result=Promise.allSettled([a,b]);controller.abort();
  assert.ok((await result).every(r=>r.status==="rejected"));assert.equal(x.stats().inflight,0);
});
test("success streams are uncollected, callback failures abort once, errors are bounded",async t=>{
  const {transport:x,url}=await fixture(t,(req,r)=>{if(req.url==="/error"){r.writeHead(429);r.end("sensitive".repeat(20));}else r.end("hello");},{maxErrorBytes:8,maxResponseBytes:1});
  let seen="";await new Promise((resolve,reject)=>x.streamRequest(url,{},null,c=>{seen+=c;assert.equal(x.stats().retainedBytes,0);},resolve,reject));assert.equal(seen,"hello");
  await assert.rejects(new Promise((resolve,reject)=>x.streamRequest(url+"/error",{},null,()=>{},resolve,reject)),{code:"UPSTREAM_RESPONSE_TOO_LARGE"});
  let calls=0;await new Promise(resolve=>x.streamRequest(url,{},null,()=>{throw new Error("callback");},()=>assert.fail(),e=>{calls++;assert.equal(e.message,"callback");resolve();}));
  await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(x.stats().retainedBytes,0);
});
test("reservation failure leaves budget unchanged; stream collectors reject unterminated frames/tool arguments",()=>{
  const b=createRetainedBudget(10), a=b.lease(8), c=b.lease(8);
  a.retain(6);assert.throws(()=>c.retain(5),{code:"UPSTREAM_RETAINED_OVERLOADED"});assert.equal(b.snapshot().retainedBytes,6);
  assert.throws(()=>a.retain(3),{code:"UPSTREAM_RESPONSE_TOO_LARGE"});a.release();c.retain(5);c.release();assert.equal(b.snapshot().retainedBytes,0);
});

test("response ownership survives setup return and cancels buffered inference on disconnect",async t=>{
  const transport=require("../lib/http-transport"), {EventEmitter}=require("node:events");
  let upstreamClosed;const closed=new Promise(r=>upstreamClosed=r);
  const {transport:x,url}=await fixture(t,(req,res)=>{req.on("close",upstreamClosed);res.write("partial");});
  const downstream=new EventEmitter();
  const pending=transport.withOwnership(()=>x.makeRequest(url,{}),downstream);
  await new Promise(r=>setTimeout(r,20));downstream.emit("close");
  await assert.rejects(pending,{code:"UPSTREAM_CLIENT_ABORTED"});await closed;
  assert.equal(x.stats().retainedBytes,0);
});
test("fetch reads are capped before parse and cancellation reaches the source",async()=>{
  const x=require("../lib/http-transport");let cancelled=false;
  const response=new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(9));},cancel(){cancelled=true;}}));
  await assert.rejects(x.withOwnership(()=>x.readFetchBody(response,8)),{code:"UPSTREAM_RESPONSE_TOO_LARGE"});assert.equal(cancelled,true);
});
test("native operations have bounded concurrency and inherit ownership cancellation",async()=>{
  const x=require("../lib/http-transport");
  const {EventEmitter}=require("node:events");const downstream=new EventEmitter();downstream.setMaxListeners(100);
  const running=Array.from({length:32},()=>x.withOwnership(()=>x.nativeOperation(()=>new Promise((resolve,reject)=>{
    const signal=x.currentSignal();signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
  })),downstream));
  const outcomes=Promise.allSettled(running);
  await assert.rejects(x.nativeOperation(()=>assert.fail()),{code:"UPSTREAM_TRANSPORT_OVERLOADED"});
  downstream.emit("close");assert.ok((await outcomes).every(r=>r.status==="rejected"));
  assert.equal(x.stats().nativeActive,0);
});

test("callback boundary pauses upstream while downstream needs drain",async t=>{
 const {EventEmitter}=require("node:events");const downstream=new EventEmitter();downstream.writableNeedDrain=true;
 const {transport:x,url}=await fixture(t,(_,r)=>r.end("ok"));let ended=false;
 const done=new Promise((resolve,reject)=>x.streamRequest(url,{downstream},null,()=>{},()=>{ended=true;resolve();},reject));
 await new Promise(r=>setTimeout(r,20));assert.equal(ended,false);
 downstream.writableNeedDrain=false;downstream.emit("drain");await done;
 assert.equal(downstream.listenerCount("close"),0);
});

test("response-bound leases remain charged after handler returns until response finish",async t=>{
 const x=require("../lib/http-transport"),{EventEmitter}=require("node:events");const downstream=new EventEmitter();
 const {transport:local,url}=await fixture(t,(_,r)=>r.end("held"),{representationMultiplier:1});
 const result=await x.withOwnership(()=>local.makeRequest(url,{}),downstream);
 assert.equal(result.body,"held");assert.equal(local.stats().retainedBytes,4);
 downstream.emit("finish");assert.equal(local.stats().retainedBytes,0);assert.equal(downstream.listenerCount("close"),0);
});
test("invalid numeric settings keep finite safe defaults",()=>{
 const x=createTransport({env:{LLM_PROXY_HTTP_MAX_SOCKETS:"0",LLM_PROXY_HTTP_MAX_TOTAL_SOCKETS:"-1",LLM_PROXY_HTTP_MAX_FREE_SOCKETS:"Infinity",LLM_PROXY_UPSTREAM_TIMEOUT_MS:"garbage",LLM_PROXY_MAX_RETAINED_UPSTREAM_BYTES:"0"}});
 assert.equal(x.config.maxSockets,64);assert.equal(x.config.maxTotalSockets,256);assert.equal(x.config.maxFreeSockets,16);assert.equal(x.config.timeoutMs,300000);assert.equal(x.stats().maxRetainedBytes,134217728);x.close();
});
test("consumed reservations free contention and allow bounded frames beyond cumulative limit",()=>{
 const x=createTransport({maxStreamBytes:64,maxRetainedBytes:64,representationMultiplier:1});
 const a=x.collector(),b=x.collector();
 for(let i=0;i<100;i++){a.retain(40);assert.throws(()=>b.retain(30),{code:"UPSTREAM_RETAINED_OVERLOADED"});a.resize(10);b.retain(30);b.resize(0);a.resize(0);}
 assert.equal(x.stats().retainedBytes,0);a.release();b.release();x.close();
});
test("failed attempts release dead payloads before the next attempt",async()=>{
 const x=require("../lib/http-transport");
 await x.withOwnership(async()=>{
   await assert.rejects(x.withAttempt(async()=>{x.collector().retain("payload");throw new Error("retry");}),/retry/);
   assert.equal(x.stats().retainedBytes,0);
 });
});
test("failed response body stays charged while the retry is delayed and releases on discard",async t=>{
 const shared=require("../lib/http-transport");let finishRetry,started;const retryStarted=new Promise(r=>started=r);
 const {transport:x,url}=await fixture(t,(req,res)=>{if(req.url==="/retry"){finishRetry=()=>res.end("ok");started();}else{res.writeHead(503);res.end("x".repeat(1024));}},{representationMultiplier:1});
 await shared.withOwnership(async()=>{
  let held;
  try{await shared.withAttempt(async()=>{throw await x.makeRequest(url,{});});}catch(error){held=error;}
  const retry=x.makeRequest(url+"/retry",{});retry.catch(()=>{});await retryStarted;
  assert.equal(held.body.length,1024);assert.equal(x.stats().retainedBytes,1024);
  held.release();held=null;assert.equal(x.stats().retainedBytes,0);
  finishRetry();const result=await retry;result.release();assert.equal(x.stats().retainedBytes,0);
 });
});
test("standalone body-bearing rejection transfers release ownership to caller",async()=>{
 const x=require("../lib/http-transport");let held;
 try{await x.withAttempt(async()=>{x.collector().retain("held");throw {status:503,body:"held"};});}catch(error){held=error;}
 assert.ok(x.stats().retainedBytes>0);held.release();assert.equal(x.stats().retainedBytes,0);
});

test("native metrics count actual live fetch attempts, HTTP failures and retries without wrapper duplicates", async t => {
 const x=require("../lib/http-transport"), metrics=require("../lib/performance-metrics");metrics.reset();
 await x.nativeOperation(async()=>{});assert.equal(metrics.snapshot().upstream.dispatches,0);
 await assert.rejects(require("../lib/provider-adapters").routeNonStreaming({protocol:"unsupported"},{},()=>assert.fail()),/Unsupported provider protocol/);
 assert.equal(metrics.snapshot().upstream.dispatches,0);
 let release;const gate=new Promise(r=>release=r);
 const {server,url}=await fixture(t,async(req,res)=>{if(req.url==="/wait")await gate;if(req.url==="/fail")res.writeHead(503);res.end("x");});
 const pending=x.withOwnership(()=>x.nativeOperation(()=>x.trackedFetch(url+"/wait")));
 await new Promise(r=>setImmediate(r));assert.equal(metrics.snapshot().upstream.dispatches,1);release();assert.equal((await pending).status,200);
 await x.withOwnership(()=>x.nativeOperation(()=>x.trackedFetch(url+"/fail")));
 const retried=await x.withOwnership(()=>x.nativeOperation(async()=>{await x.trackedFetch(url);return x.trackedFetch(url); }));
 assert.equal(retried.status,200);
 const s=metrics.snapshot().upstream;
 assert.deepEqual({dispatches:s.dispatches,errors:s.errors,retries:s.retries},{dispatches:4,errors:1,retries:1});
 assert.equal(server.listening,true);
});

test("shared request inside native ownership is counted once and explicit recovery is a retry", async t => {
 const x=require("../lib/http-transport"), metrics=require("../lib/performance-metrics");metrics.reset();
 const {transport:local,url}=await fixture(t,(_,res)=>res.end("ok"));
 await x.withOwnership(()=>x.nativeOperation(async()=>{const r=await local.makeRequest(url,{});r.release();}));
 await x.withOwnership(()=>x.withAttempt(async()=>{const r=await local.makeRequest(url,{});r.release();},{retry:true}));
 const s=metrics.snapshot().upstream;
 assert.equal(s.dispatches,2);assert.equal(s.retries,1);
});

test("tracked fetch settles on body truncation and distinguishes deadline from client cancellation", async t => {
 const x=require("../lib/http-transport"),metrics=require("../lib/performance-metrics");
 const {url}=await fixture(t,(req,res)=>{
  if(req.url==="/truncated"){res.writeHead(200,{"content-length":"100"});res.write("x");setImmediate(()=>res.destroy());return;}
  res.writeHead(200);res.flushHeaders();res.write("x");
 });
 metrics.reset();let response=await x.trackedFetch(url+"/truncated");await assert.rejects(response.text());
 assert.deepEqual({errors:metrics.snapshot().upstream.errors,cancels:metrics.snapshot().upstream.cancels},{errors:1,cancels:0});

 metrics.reset();const pre=new AbortController();pre.abort(x.boundaryError("UPSTREAM_TIMEOUT",504));
 await assert.rejects(x.trackedFetch(url,{signal:pre.signal}),{code:"UPSTREAM_TIMEOUT"});assert.equal(metrics.snapshot().upstream.dispatches,0);

 for(const [code,expected] of [["UPSTREAM_TIMEOUT",{errors:1,cancels:0}],["UPSTREAM_CLIENT_ABORTED",{errors:0,cancels:1}]]){
  metrics.reset();const controller=new AbortController();response=await x.trackedFetch(url,{signal:controller.signal});
  const reading=response.text();controller.abort(Object.assign(new Error(code),{code}));await assert.rejects(reading);
  assert.deepEqual({errors:metrics.snapshot().upstream.errors,cancels:metrics.snapshot().upstream.cancels},expected);
 }
});

test("tracked fetch deadline before headers is an error", async t => {
 const x=require("../lib/http-transport"),metrics=require("../lib/performance-metrics");metrics.reset();
 const {url}=await fixture(t,()=>{});const controller=new AbortController();
 const pending=x.trackedFetch(url,{signal:controller.signal});setImmediate(()=>controller.abort(x.boundaryError("UPSTREAM_TIMEOUT",504)));
 await assert.rejects(pending);assert.deepEqual({dispatches:metrics.snapshot().upstream.dispatches,errors:metrics.snapshot().upstream.errors,cancels:metrics.snapshot().upstream.cancels},{dispatches:1,errors:1,cancels:0});
});
