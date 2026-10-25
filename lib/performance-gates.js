"use strict";
const SETTINGS = {maxP95Ms:"BENCH_MAX_P95_MS",maxP99Ms:"BENCH_MAX_P99_MS",minSuccessfulRps:"BENCH_MIN_SUCCESSFUL_RPS",maxRssGrowthBytes:"BENCH_MAX_RSS_GROWTH_BYTES",maxHeapGrowthBytes:"BENCH_MAX_HEAP_GROWTH_BYTES"};
function gateConfig(env=process.env) {
  const config={enforce:env.BENCH_ENFORCE_GATES === "true"};
  for(const [key,name] of Object.entries(SETTINGS)) if(env[name] !== undefined && env[name] !== "") config[key]=Number(env[name]);
  return config;
}
function evaluateGates(report, limits={}) {
  const failures=[];
  const before=report.metrics?.before, after=report.metrics?.after;
  const growth=(key)=>Number.isFinite(before?.memory?.[key]) && Number.isFinite(after?.memory?.[key]) ? after.memory[key]-before.memory[key] : null;
  const measurements={p95Ms:report.latency_ms?.p95,p99Ms:report.latency_ms?.p99,successfulRps:report.wall_duration_ms>0 && Number.isFinite(report.counts?.completed) ? report.counts.completed*1000/report.wall_duration_ms:null,rssGrowthBytes:growth("rss"),heapGrowthBytes:growth("heapUsed")};
  const check=(name,value,limit,direction="max")=>{
    if(!Number.isFinite(value)) failures.push({gate:name,reason:"measurement_unavailable"});
    else if(!Number.isFinite(limit)||limit<0) failures.push({gate:name,reason:"invalid_threshold"});
    else if(direction === "min" ? value<limit:value>limit) failures.push({gate:name,reason:"threshold_exceeded",value,limit});
  };
  for(const key of ["error","timeout","aborted"]) check(key,report.counts?.[key],0);
  for(const key of ["inflight"]) check(`client.${key}`,after?.client?.[key],0);
  for(const key of ["inflight","pending","nativeActive","retainedBytes"]) check(`transport.${key}`,after?.transport?.[key],0);
  for(const [key,value,direction] of [["maxP95Ms",measurements.p95Ms],["maxP99Ms",measurements.p99Ms],["minSuccessfulRps",measurements.successfulRps,"min"],["maxRssGrowthBytes",measurements.rssGrowthBytes],["maxHeapGrowthBytes",measurements.heapGrowthBytes]]) if(Object.hasOwn(limits,key)) check(key,value,limits[key],direction);
  if(!report.counts?.attempted || report.counts.completed !== report.counts.attempted) failures.push({gate:"completion_count",reason:"incomplete_run"});
  return {passed:failures.length===0,failures,measurements,thresholds:limits};
}
function gateExitCode(result,enforce=false){return enforce && !result.passed ? 1:0;}
module.exports={gateConfig,evaluateGates,gateExitCode};
