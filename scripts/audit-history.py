#!/usr/bin/env python3
"""Audit reachable object bytes and ref names against an external literal term."""
import argparse
import json
import re
import subprocess


def git(repo, *args):
    return subprocess.check_output(["git", "-C", repo, *args])


def audit(repo, term):
    pattern = re.compile(re.escape(term), re.IGNORECASE)
    refs = git(repo, "for-each-ref", "--format=%(refname)").splitlines()
    objects = git(repo, "rev-list", "--objects", "--all").splitlines()
    paths = [row.split(b" ", 1)[1] for row in objects if b" " in row]
    ids = git(repo, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)").splitlines()
    bad = {"refs": sum(bool(pattern.search(x)) for x in refs),
           "paths": sum(bool(pattern.search(x)) for x in paths),
           "blobs": 0, "commits": 0, "tags": 0, "trees": 0}
    process = subprocess.Popen(["git", "-C", repo, "cat-file", "--batch"],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        for oid in ids:
            process.stdin.write(oid + b"\n")
            process.stdin.flush()
            header = process.stdout.readline().split()
            size = int(header[2])
            data = process.stdout.read(size)
            process.stdout.read(1)
            kind = header[1].decode() + "s"
            if pattern.search(data):
                bad[kind] += 1
    finally:
        process.stdin.close()
        process.wait()
    return {"objects": len(ids), "refs": len(refs), "matches": bad,
            "clean": not any(bad.values())}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--term-file", required=True)
    args = parser.parse_args()
    with open(args.term_file, "rb") as source:
        term = source.read().strip()
    if not term:
        parser.error("Nonempty external term required")
    result = audit(args.repo, term)
    print(json.dumps(result))
    raise SystemExit(0 if result["clean"] else 1)
