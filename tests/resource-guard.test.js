"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {spawnSync} = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const guard = path.join(__dirname,"../scripts/resource-guard.js");
function run(memory,cpu,pids) { return spawnSync(process.execPath,[guard],{env:{...process.env,PROXY_RESOURCE_MEMORY:memory,PROXY_RESOURCE_CPUS:cpu,PROXY_RESOURCE_PIDS:pids},encoding:"utf8"}); }
for (const [memory,cpu,pids] of [["2g","2.0","256"],["1g","1.0","256"],["128m","0.5","32"],["256MiB",".5","32"],["1.1g","1","256"],["1TB","1","256"],["268435456",".25","48"]]) test(`guard accepts ${memory}/${cpu}/${pids}`,()=>assert.equal(run(memory,cpu,pids).status,0));
for (const [memory,cpu,pids] of [["0","2","256"],["0g","2","256"],["-1g","2","256"],["oops","2","256"],["1g","0","256"],["1g","-1","256"],["1g","Infinity","256"],["1g","1","0"],["1g","1","-1"],["1g","1","1.5"],["1g","1","oops"],["","1","256"]]) test(`guard rejects ${memory}/${cpu}/${pids}`,()=>{const result=run(memory,cpu,pids);assert.equal(result.status,1);assert.match(result.stderr,/Invalid proxy resource/);});
test("both Compose services run guard before original image entrypoint and command",()=>{const text=fs.readFileSync(path.join(__dirname,"../docker-compose.yml"),"utf8");for(const service of ["llm-proxy","codex-proxy"]){const block=text.split(`  ${service}:`)[1].split(/\n  [a-z]/)[0];assert.match(block,/resource-guard\.js/);assert.match(block,/entrypoint: \["\/bin\/sh", "\/opt\/proxy-resource-entrypoint\.sh"\]/);assert.match(fs.readFileSync(path.join(__dirname,"../scripts/resource-entrypoint.sh"),"utf8"),/node \/opt\/proxy-resource-guard\.js\nexec docker-entrypoint\.sh "\$@"/);for(const name of ["MEMORY","CPUS","PIDS"])assert.match(block,new RegExp(`PROXY_RESOURCE_${name}:`));assert.match(block,/resource-guard\.js:ro/);assert.match(block,service === "llm-proxy" ? /command: \["node", "llm-proxy\.js"\]/ : /command: \["openai-oauth", "--host", "0\.0\.0\.0", "--port", "10531"\]/);}});

test("baseline configuration equality ignores property order",()=>{const {sameFixtureConfig}=require("../scripts/performance-fixture");assert.equal(sameFixtureConfig({timeout_ms:10000,concurrency:8,warmup:5,repeat:50},{repeat:50,warmup:5,concurrency:8,timeoutMs:10000}),true);assert.equal(sameFixtureConfig({timeout_ms:10001,concurrency:8,warmup:5,repeat:50},{repeat:50,warmup:5,concurrency:8,timeoutMs:10000}),false);});

test("startup wrapper blocks invalid limits and preserves valid command arguments",t=>{
 const os=require("node:os"); const dir=fs.mkdtempSync(path.join(os.tmpdir(),"proxy-guard-test-")); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,"node"),`#!/bin/sh\nexec "${process.execPath}" "${guard}"\n`,{mode:0o755});
 fs.writeFileSync(path.join(dir,"docker-entrypoint.sh"),`#!/bin/sh\nprintf '%s\\n' "$@"\n`,{mode:0o755});
 const env={...process.env,PATH:dir,PROXY_RESOURCE_MEMORY:"1g",PROXY_RESOURCE_CPUS:"1",PROXY_RESOURCE_PIDS:"256"};
 const args=[path.join(__dirname,"../scripts/resource-entrypoint.sh"),"openai-oauth","--host","0.0.0.0","--port","10531","argument with spaces"];
 const valid=spawnSync("/bin/sh",args,{env,encoding:"utf8"});assert.equal(valid.status,0);assert.deepEqual(valid.stdout.trim().split("\n"),args.slice(1));
 const invalid=spawnSync("/bin/sh",args,{env:{...env,PROXY_RESOURCE_MEMORY:"0"},encoding:"utf8"});assert.equal(invalid.status,1);assert.equal(invalid.stdout,"");
});
