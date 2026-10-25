#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {execFileSync} = require("node:child_process");
const {validateCredential,readCredentialFile} = require("../lib/claude-credential-file");
function readKeychain() {
  return execFileSync("/usr/bin/security",["find-generic-password","-s","Claude Code-credentials","-w"],{encoding:"utf8",timeout:5000,maxBuffer:65536,stdio:["ignore","pipe","pipe"]});
}
function syncCredentials({output=path.resolve(__dirname,"../data/claude-oauth.json"),credentialsFile=path.join(os.homedir(),".claude/.credentials.json"),readKeychain:read=readKeychain}={}) {
  if (process.env.CLAUDE_CONFIG_DIR) throw new Error("Custom Claude config directories require a separate credential sync configuration");
  let raw;
  try {raw=read();} catch {raw=null;}
  let source;
  try {source=raw===null ? readCredentialFile(credentialsFile) : JSON.parse(raw);} catch {throw new Error("Invalid Claude credential payload");}
  const credential=validateCredential(source?.claudeAiOauth);
  fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
  try {
    const previous=readCredentialFile(output);
    if(previous.accessToken===credential.accessToken && previous.expiresAt===credential.expiresAt && Object.keys(previous).length===2 && !fs.lstatSync(output).isSymbolicLink()) {
      fs.chmodSync(output,0o600);
      return {expiresAt:credential.expiresAt};
    }
  } catch {}
  const temporary=`${output}.${process.pid}.${require("node:crypto").randomBytes(8).toString("hex")}.tmp.json`;
  try {
    fs.writeFileSync(temporary,JSON.stringify(credential)+"\n",{mode:0o600,flag:"wx"});
    fs.renameSync(temporary,output);
  } finally {try {fs.unlinkSync(temporary);} catch {}}
  return {expiresAt:credential.expiresAt};
}
function main(args=process.argv.slice(2)) {
  const options={}; let watch=false,interval=60000;
  for(let i=0;i<args.length;i++) {
    if(args[i]==="--watch") watch=true;
    else if(args[i]==="--output" && args[i+1]) options.output=path.resolve(args[++i]);
    else if(args[i]==="--interval" && args[i+1]) interval=Number(args[++i])*1000;
    else throw new Error("Invalid arguments");
  }
  if(!Number.isSafeInteger(interval)||interval<1000||interval>3600000) throw new Error("Invalid interval");
  let failures=0;
  const run=()=>{
    try {syncCredentials(options); failures=0;} catch {
      // Subprocess errors may contain credential stdout/stderr. Never print them.
      if(failures++===0) process.stderr.write("Claude credential sync unavailable; existing snapshot retained.\n");
      if(!watch) process.exitCode=1;
    }
    if(watch) setTimeout(run,interval);
  };
  run();
}
if(require.main===module) {try {main();} catch {process.stderr.write("Invalid credential sync arguments.\n");process.exitCode=1;}}
module.exports={syncCredentials,main};
