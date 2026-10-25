"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),http=require("node:http");
const {once}=require("node:events");
const responses=require("../lib/responses"),transport=require("../lib/http-transport");
async function fixture(t,stream){
 let upstreamClosed,started;const closed=new Promise(r=>upstreamClosed=r),ready=new Promise(r=>started=r);
 const upstream=http.createServer((req,res)=>{res.writeHead(200,{"content-type":stream?"text/event-stream":"application/json"});res.write(stream?'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n':'{"choices":[');started();res.on("close",upstreamClosed);});
 upstream.listen(0,"127.0.0.1");await once(upstream,"listening");
 responses.init({handleChatCompletion:async(body,bridge)=>transport.withOwnership(async()=>{
  const url=`http://127.0.0.1:${upstream.address().port}`;
  if(stream)return new Promise((resolve,reject)=>transport.streamRequest(url, {downstream:bridge},null,c=>bridge.write(c),()=>{bridge.end();resolve();},reject));
  const result=await transport.makeRequest(url,{});bridge.end(result.body);
 },bridge)});
 const server=http.createServer((req,res)=>responses.handleResponsesHTTP(req,res,{model:"fixture",input:"hello",stream}).catch(()=>res.destroy()));
 server.listen(0,"127.0.0.1");await once(server,"listening");
 t.after(()=>{upstream.closeAllConnections();upstream.close();server.closeAllConnections();server.close();transport.close();});
 return {url:`http://127.0.0.1:${server.address().port}/v1/responses`,closed,ready};
}
for(const stream of [false,true])test(`Responses ${stream?'SSE':'JSON'} disconnect cancels inference`,{timeout:2000},async t=>{
 const f=await fixture(t,stream);const req=http.get(f.url);req.on("error",()=>{});req.on("response",r=>r.on("error",()=>{}));await f.ready;req.destroy();
 await Promise.race([f.closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error("upstream not cancelled")),150))]);
 assert.equal(transport.stats().retainedBytes,0);
});
test("Responses SSE bridge reflects real slow-reader drain pressure",async t=>{
 let pressure=false;
 responses.init({handleChatCompletion:async(body,bridge)=>{
  bridge.writeHead(200);bridge.write(`data: ${JSON.stringify({choices:[{delta:{content:"x".repeat(32000)}}]})}\n\n`);
  pressure=bridge.writableNeedDrain===true;await transport.waitForDrain(bridge,transport.currentSignal());bridge.end();
 }});
 const server=http.createServer({highWaterMark:128},(req,res)=>responses.handleResponsesHTTP(req,res,{model:"fixture",input:"hello",stream:true}));server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>{server.closeAllConnections();server.close();});
 await new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${server.address().port}/v1/responses`,r=>{r.pause();setTimeout(()=>r.resume(),30);r.on("end",resolve);r.on("error",reject);}).on("error",reject));assert.equal(pressure,true);
});
test("Responses JSON retains captured upstream body through conversion and send",async t=>{
 let atSend=0;
 responses.init({handleChatCompletion:async(_body,bridge)=>transport.withOwnership(async()=>{
  const hold=transport.collector(1024,false);hold.retain("source");
  bridge.end(JSON.stringify({choices:[{message:{role:"assistant",content:"held response"},finish_reason:"stop"}]}));
 },bridge)});
 const server=http.createServer((req,res)=>{const end=res.end.bind(res);res.end=(...args)=>{atSend=transport.stats().retainedBytes;return end(...args);};responses.handleResponsesHTTP(req,res,{model:"fixture",input:"hello"});});
 server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>{server.closeAllConnections();server.close();});
 await new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${server.address().port}`,r=>{r.resume();r.on("end",resolve);}).on("error",reject));
 assert.ok(atSend>0);assert.equal(transport.stats().retainedBytes,0);
});
for(const mode of ["response.cancel","disconnect"])test(`Responses WS ${mode} cancels active inference`,{timeout:2000},async t=>{
 const {WebSocketServer,WebSocket}=require("ws");
 let started,closed;const ready=new Promise(r=>started=r),cancelled=new Promise(r=>closed=r);
 const upstream=http.createServer((req,res)=>{res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');started();res.on("close",closed);});upstream.listen(0,"127.0.0.1");await once(upstream,"listening");
 responses.init({handleChatCompletion:async(_body,bridge)=>transport.withOwnership(()=>new Promise((resolve,reject)=>transport.streamRequest(`http://127.0.0.1:${upstream.address().port}`,{downstream:bridge},null,c=>bridge.write(c),()=>{bridge.end();resolve();},reject)),bridge)});
 const server=http.createServer(),wss=new WebSocketServer({server});wss.on("connection",(ws,req)=>responses.handleResponsesWS(ws,req));server.listen(0,"127.0.0.1");await once(server,"listening");
 const client=new WebSocket(`ws://127.0.0.1:${server.address().port}`);await once(client,"open");t.after(()=>{client.terminate();for(const c of wss.clients)c.terminate();wss.close();server.close();upstream.closeAllConnections();upstream.close();});
 client.send(JSON.stringify({type:"response.create",response:{model:"fixture",input:[]}}));await ready;
 if(mode==="disconnect")client.terminate();else client.send(JSON.stringify({type:"response.cancel"}));
 await Promise.race([cancelled,new Promise((_,reject)=>setTimeout(()=>reject(new Error("WS upstream not cancelled")),150))]);assert.equal(transport.stats().retainedBytes,0);
});
