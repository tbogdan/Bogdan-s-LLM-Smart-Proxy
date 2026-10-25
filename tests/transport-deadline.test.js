const test=require("node:test"),assert=require("node:assert/strict"),http=require("node:http");
const transport=require("../lib/http-transport");
test("helper deadline aborts buffered upstream and releases leases without cancelling parent",async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(200);res.write("partial");});await new Promise(r=>server.listen(0,"127.0.0.1",r));t.after(()=>{server.closeAllConnections();server.close();});
 const local=transport.createTransport();t.after(()=>local.close());
 await transport.withOwnership(async()=>{const parent=transport.currentSignal();await assert.rejects(transport.withDeadline(()=>local.makeRequest(`http://127.0.0.1:${server.address().port}`),30),e=>e.code==="UPSTREAM_TIMEOUT");assert.equal(parent.aborted,false);await new Promise(r=>setImmediate(r));assert.equal(local.stats().inflight,0);assert.equal(local.stats().leases,0);assert.equal(local.stats().retainedBytes,0);});
});
test("native helper sees deadline signal and cannot start later sibling attempts",async()=>{
 await transport.withOwnership(async()=>{const parent=transport.currentSignal();let child,attempted=false;await assert.rejects(transport.withDeadline(()=>transport.nativeOperation(async()=>{child=transport.currentSignal();await new Promise(r=>child.addEventListener("abort",r,{once:true}));await transport.nativeOperation(()=>{attempted=true;});}),20),e=>e.code==="UPSTREAM_TIMEOUT");assert.equal(child.aborted,true);assert.equal(parent.aborted,false);assert.equal(attempted,false);});
});
test("parent cancellation propagates into deadline while successful helper clears its timer",async()=>{
 const {EventEmitter}=require("node:events");const response=new EventEmitter();await transport.withOwnership(async()=>{const parent=transport.currentSignal();assert.equal(await transport.withDeadline(async()=>42,15),42);await new Promise(r=>setTimeout(r,25));assert.equal(parent.aborted,false);const pending=transport.withDeadline(()=>new Promise((resolve,reject)=>transport.currentSignal().addEventListener("abort",()=>reject(transport.currentSignal().reason),{once:true})),1000);response.emit("close");await assert.rejects(pending,e=>e.code==="UPSTREAM_CLIENT_ABORTED");},response);
});

test("already-cancelled parent never runs helper work",async()=>{
 const {EventEmitter}=require("node:events");const response=new EventEmitter();await transport.withOwnership(async()=>{response.emit("close");let ran=false;await assert.rejects(transport.withDeadline(()=>{ran=true;},100),e=>e.code==="UPSTREAM_CLIENT_ABORTED");assert.equal(ran,false);},response);
});
