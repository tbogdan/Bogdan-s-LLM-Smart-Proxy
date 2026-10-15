const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("history audit covers historical blobs, paths, commit identities and annotated tags", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-fixture-"));
  const run = (cmd, args, options = {}) =>
    spawnSync(cmd, args, { cwd: dir, encoding: "utf8", ...options });
  const git = (...args) => {
    const r = run("git", args);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture Author");
    git("config", "user.email", "fixture@example.invalid");
    const term = "ForbiddenFixture";
    fs.writeFileSync(
      path.join(dir, term + ".txt"),
      "Old " + term.toLowerCase(),
    );
    git("add", ".");
    git("commit", "-qm", "Historical " + term.toUpperCase());
    git("tag", "-a", "old-tag", "-m", "Historical " + term);
    git("rm", "-q", term + ".txt");
    git("commit", "-qm", "Remove old file");
    const termFile = path.join(dir, "term");
    fs.writeFileSync(termFile, term);
    const script = path.join(__dirname, "../scripts/audit-history.py");
    const result = run(process.env.HISTORY_PYTHON || "python3", [
      script,
      "--repo",
      dir,
      "--term-file",
      termFile,
    ]);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    for (const field of ["blobs", "paths", "commits", "tags"])
      assert.ok(report.matches[field] > 0, field);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "sanitation retains history in independent mirror and leaves source unchanged",
  { skip: !process.env.HISTORY_PYTHON },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sanitize-fixture-"));
    const source = path.join(dir, "source");
    fs.mkdirSync(source);
    const git = (...args) => {
      const r = spawnSync("git", args, { cwd: source, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    try {
      git("init", "-q");
      git("config", "user.name", "ForbiddenFixture Contributor");
      git("config", "user.email", "fixture@ForbiddenFixture.invalid");
      fs.writeFileSync(
        path.join(source, "ForbiddenFixture.txt"),
        "FORBIDDENFIXTURE payload",
      );
      git("add", ".");
      git("commit", "-qm", "Initial ForbiddenFixture");
      fs.writeFileSync(path.join(source, "safe.txt"), "Safe content");
      git("add", ".");
      git("commit", "-qm", "Second");
      git(
        "tag",
        "-a",
        "ForbiddenFixture-tag",
        "-m",
        "ForbiddenFixture annotation",
      );
      const before = git("rev-parse", "HEAD");
      const termFile = path.join(dir, "term");
      fs.writeFileSync(termFile, "ForbiddenFixture");
      const destination = path.join(dir, "clean.git");
      const result = spawnSync(
        process.env.HISTORY_PYTHON,
        [
          path.join(__dirname, "../scripts/sanitize-history.py"),
          "--source",
          source,
          "--destination",
          destination,
          "--term-file",
          termFile,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
      assert.equal(git("rev-parse", "HEAD"), before);
      const count = spawnSync(
        "git",
        ["-C", destination, "rev-list", "--count", "--all"],
        { encoding: "utf8" },
      );
      assert.equal(count.stdout.trim(), "2");
      const audit = spawnSync(
        process.env.HISTORY_PYTHON,
        [
          path.join(__dirname, "../scripts/audit-history.py"),
          "--repo",
          destination,
          "--term-file",
          termFile,
        ],
        { encoding: "utf8" },
      );
      assert.equal(audit.status, 0, audit.stderr);
      assert.equal(JSON.parse(audit.stdout).clean, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
