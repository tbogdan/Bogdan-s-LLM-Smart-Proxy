"use strict";
const fs = require("node:fs");
const MAX_BYTES = 65536;
function validateCredential(value, now = Date.now()) {
  if (!value || typeof value.accessToken !== "string" || !value.accessToken || value.accessToken.length > 16384 || /\s/.test(value.accessToken) || !Number.isSafeInteger(value.expiresAt)) throw new Error("Invalid Claude credential payload");
  if (value.expiresAt <= now) throw new Error("Claude credential expired");
  return {accessToken:value.accessToken, expiresAt:value.expiresAt};
}
function readCredentialFile(file) {
  const fd=fs.openSync(file,"r");
  try {
    if(fs.fstatSync(fd).size>MAX_BYTES) throw new Error("Invalid Claude credential payload");
    const buffer=Buffer.alloc(MAX_BYTES+1), length=fs.readSync(fd,buffer,0,buffer.length,0);
    if(length>MAX_BYTES) throw new Error("Invalid Claude credential payload");
    return JSON.parse(buffer.toString("utf8",0,length));
  } finally {fs.closeSync(fd);}
}
module.exports={validateCredential,readCredentialFile};
