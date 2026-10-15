#!/usr/bin/env python3
"""Create an independent sanitized mirror. Never rewrite the source repository."""
import argparse
import json
import pathlib
import subprocess
import sys

from importlib.machinery import SourceFileLoader


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
    auditor = SourceFileLoader("history_auditor", str(pathlib.Path(__file__).with_name("audit-history.py"))).load_module()
    result = auditor.audit(str(destination), term)
    subprocess.run(["git", "-C", str(destination), "fsck", "--full"], check=True)
    print(json.dumps({"destination": str(destination), "audit": result}))
    if not result["clean"]:
        raise SystemExit("Sanitized mirror failed audit; source remains untouched")


if __name__ == "__main__":
    main()
