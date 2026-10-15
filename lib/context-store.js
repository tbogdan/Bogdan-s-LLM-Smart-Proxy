"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { digest } = require("./task-store");
function createContextStore({ dataDir, maxBytes = 100 * 1024 * 1024 } = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  function dir(taskKey) {
    return path.join(dataDir, digest(taskKey));
  }
  function put({ taskKey, role = "primary", bytes, strategyVersion = "v1" }) {
    const buf = Buffer.from(bytes);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const ref = digest(JSON.stringify([role, sha256, strategyVersion]));
    const folder = dir(taskKey),
      p = path.join(folder, ref);
    if (!fs.existsSync(p)) {
      let size = 0;
      for (const f of fs.readdirSync(dataDir, {
        recursive: true,
        withFileTypes: true,
      }))
        if (f.isFile())
          size += fs.statSync(path.join(f.parentPath || f.path, f.name)).size;
      if (size + buf.length > maxBytes)
        throw Object.assign(
          new Error("Original store full; preserve active originals"),
          { code: "CONTEXT_CAPACITY" },
        );
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const tmp = p + "." + crypto.randomUUID() + ".tmp";
      try {
        fs.writeFileSync(tmp, buf, { flag: "wx", mode: 0o600 });
        fs.renameSync(tmp, p);
      } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      }
    }
    return { ref, sha256, bytes: buf.length, strategyVersion };
  }
  function get({ taskKey, ref, start = 0, end }) {
    if (!/^[a-f0-9]{64}$/.test(ref || ""))
      throw new Error("Original not found");
    let data;
    try {
      data = fs.readFileSync(path.join(dir(taskKey), ref));
    } catch {
      throw new Error("Original not found");
    }
    if (
      !Number.isInteger(start) ||
      start < 0 ||
      (end !== undefined && (!Number.isInteger(end) || end < start))
    )
      throw new Error("Invalid range");
    return data.subarray(start, end);
  }
  function representation({ taskKey, ref, text }) {
    if (!/^[a-f0-9]{64}$/.test(ref || "")) throw new Error("Invalid reference");
    const p = path.join(dir(taskKey), ref + ".representation");
    if (text !== undefined) {
      if (!fs.existsSync(p))
        fs.writeFileSync(p, text, { flag: "wx", mode: 0o600 });
      return text;
    }
    try {
      return fs.readFileSync(p, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  return {
    put,
    get,
    representation,
    releaseTask: (taskKey) =>
      fs.rmSync(dir(taskKey), { recursive: true, force: true }),
    close() {},
  };
}
module.exports = { createContextStore };
