#!/usr/bin/env python3
"""Create the one storybloq ticket from the uploaded instruction file, passing the text as an
argv value (no shell substitution, bytes preserved). Prints the ticket id."""
import json
import subprocess
import sys

path = sys.argv[1]
with open(path, "rb") as fh:
    text = fh.read().decode("utf-8")
first = next((line for line in text.splitlines() if line.strip()), "task")
title = first.strip()[:120]
r = subprocess.run(
    ["storybloq", "ticket", "create", "--type", "task", "--title", title, "--description", text, "--format", "json"],
    capture_output=True, text=True,
)
if r.returncode != 0:
    sys.stderr.write(r.stderr)
    sys.exit(r.returncode)
out = json.loads(r.stdout)
data = out.get("data", out)
tid = data.get("displayId") or data.get("id") or (data.get("item") or {}).get("displayId")
if not tid:
    sys.stderr.write("no ticket id in: " + r.stdout[:300])
    sys.exit(3)
print(tid)
