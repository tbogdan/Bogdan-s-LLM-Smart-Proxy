#!/usr/bin/env python3
"""Create an independent sanitized mirror. Never rewrite the source repository."""
import argparse
import json
import pathlib
import subprocess
import sys

import importlib.util


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--term-file", required=True)
    args = parser.parse_args()
    source = pathlib.Path(args.source).resolve()
    destination = pathlib.Path(args.destination).resolve()
    term = pathlib.Path(args.term_file).read_bytes().strip()
    if not term or destination.exists() or destination == source or source in destination.parents:
        parser.error("Require nonempty term and new destination outside source")
    # Verify dependency before creating any repository.
    subprocess.run([sys.executable, "-m", "git_filter_repo", "--version"], check=True,
                   stdout=subprocess.DEVNULL)
    subprocess.run(["git", "clone", "--mirror", "--no-local", str(source), str(destination)], check=True)
    # App diff snapshots may point directly to trees, which filter-repo skips.
    # They are editor recovery metadata, not branches/tags; the external source
    # bundle retains them. Drop only this documented namespace in the new mirror.
    app_refs = subprocess.check_output(["git", "-C", str(destination), "for-each-ref", "--format=%(refname)", "refs/codex/"]).decode().splitlines()
    for ref in app_refs:
        subprocess.run(["git", "-C", str(destination), "update-ref", "-d", ref], check=True)
    expression = "__import__('re').sub(" + repr(__import__('re').escape(term)) + ", b'Project', VALUE, flags=__import__('re').I)"
    callbacks = []
    for flag, variable in [("--filename-callback", "filename"), ("--message-callback", "message"),
                           ("--name-callback", "name"), ("--refname-callback", "refname")]:
        callbacks += [flag, "return " + expression.replace("VALUE", variable)]
    callbacks += ["--email-callback", "return b'contributor@example.invalid' if " +
                  repr(term.lower()) + " in email.lower() else email"]
    callbacks += ["--blob-callback", "blob.data = " + expression.replace("VALUE", "blob.data")]
    subprocess.run([sys.executable, "-m", "git_filter_repo", "--force", *callbacks],
                   cwd=destination, check=True)
    spec = importlib.util.spec_from_file_location("history_auditor", pathlib.Path(__file__).with_name("audit-history.py"))
    auditor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(auditor)
    result = auditor.audit(str(destination), term)
    subprocess.run(["git", "-C", str(destination), "fsck", "--full"], check=True)
    print(json.dumps({"destination": str(destination), "audit": result}))
    if not result["clean"]:
        raise SystemExit("Sanitized mirror failed audit; source remains untouched")


if __name__ == "__main__":
    main()
