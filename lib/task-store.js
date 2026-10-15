"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const digest = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
function createTaskStore({ dataDir, maxRecords = 10000 } = {}) {
  if (!dataDir) throw new Error("dataDir required");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(dataDir, ".writer-lock");
  const conflict = () =>
    Object.assign(
      new Error("State directory already has a writer or ownership was lost"),
      { code: "STATE_WRITER_CONFLICT" },
    );
  function namespace() {
    try {
      return fs.readlinkSync("/proc/self/ns/pid");
    } catch {
      return "host:" + require("node:os").hostname();
    }
  }
  function startToken(pid) {
    try {
      return fs
        .readFileSync("/proc/" + pid + "/stat", "utf8")
        .split(") ")[1]
        .split(" ")[19];
    } catch {
      return null;
    }
  }
  const owner = {
    pid: process.pid,
    namespace: namespace(),
    start: startToken(process.pid),
    token: crypto.randomUUID(),
  };
  if (fs.existsSync(lock)) {
    const st = fs.statSync(lock);
    let previous;
    try {
      previous = JSON.parse(fs.readFileSync(lock, "utf8"));
    } catch {
      throw conflict();
    }
    if (typeof previous === "number") previous = { pid: previous };
    let dead = false;
    if (previous.namespace === owner.namespace) {
      try {
        process.kill(previous.pid, 0);
        if (previous.start && startToken(previous.pid) !== previous.start)
          dead = true;
      } catch (e) {
        if (e.code === "ESRCH") dead = true;
      }
    }
    // Across PID namespaces, a PID cannot prove liveness. Only an expired
    // heartbeat allows recovery; every read/write also checks ownership.
    const expired = Date.now() - st.mtimeMs > 2000;
    if (!dead && (!expired || previous.namespace === owner.namespace))
      throw conflict();
    if (fs.statSync(lock).ino !== st.ino) throw conflict();
    fs.unlinkSync(lock);
  }
  let lockFd;
  try {
    lockFd = fs.openSync(lock, "wx", 0o600);
    fs.writeFileSync(lockFd, JSON.stringify(owner));
    fs.fsyncSync(lockFd);
  } catch (e) {
    throw conflict();
  }
  const lockInode = fs.fstatSync(lockFd).ino;
  let closed = false;
  function ownsLock() {
    try {
      return (
        fs.statSync(lock).ino === lockInode &&
        JSON.parse(fs.readFileSync(lock, "utf8")).token === owner.token
      );
    } catch {
      return false;
    }
  }
  const heartbeat = setInterval(() => {
    if (!closed && ownsLock()) {
      const time = new Date();
      fs.futimesSync(lockFd, time, time);
    }
  }, 500);
  heartbeat.unref();
  function assertOwnership() {
    if (!ownsLock()) throw conflict();
  }
  const queues = new Map();
  const file = (key) => {
    if (typeof key !== "string" || !key || key.length > 1024)
      throw new Error("Invalid state key");
    return path.join(dataDir, digest(key) + ".json");
  };
  function get(key) {
    if (closed) throw new Error("Store closed");
    assertOwnership();
    const p = file(key);
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw Object.assign(new Error("Corrupt state; dispatch denied"), {
        code: "STATE_CORRUPT",
      });
    }
  }
  function updateSync(key, update) {
    const old = get(key);
    if (
      !old &&
      fs.readdirSync(dataDir).filter((x) => x.endsWith(".json")).length >=
        maxRecords
    )
      throw Object.assign(
        new Error("State capacity reached; active records retained"),
        { code: "STATE_CAPACITY" },
      );
    const { record, result } = update(old);
    if (!record || typeof record.then === "function")
      throw new Error("Synchronous record update required");
    const p = file(key),
      temp = p + "." + crypto.randomUUID() + ".tmp";
    let fd;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      assertOwnership();
      fs.renameSync(temp, p);
      const directory = fs.openSync(dataDir, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return result;
  }
  async function transaction(key, update) {
    const prior = queues.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(() => updateSync(key, update));
    queues.set(key, next);
    try {
      return await next;
    } finally {
      if (queues.get(key) === next) queues.delete(key);
    }
  }
  function close() {
    if (queues.size) throw new Error("Pending state writes");
    if (!closed) {
      closed = true;
      clearInterval(heartbeat);
      if (ownsLock()) fs.unlinkSync(lock);
      fs.closeSync(lockFd);
    }
  }
  return { get, updateSync, transaction, close };
}
module.exports = { createTaskStore, digest };
