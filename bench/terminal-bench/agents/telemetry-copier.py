#!/usr/bin/env python3
"""Incremental copy of storybloq state into the harness logs dir so a timeout or cancel still
leaves the latest session state on the host.

Every snapshot is copied into its own numbered directory (<dest>/.story.<n>) and published by
swapping the <dest>/.story symlink with a single atomic rename, so a reader always sees a
complete snapshot: either the previous one or the new one, never a partial copy and never a
gap. last-snapshot is written only after a successful publish. Usage:
  telemetry-copier.py <workdir> <dest> [--once] [--interval SECONDS]
"""
from __future__ import annotations

import os
import shutil
import sys
import time
from datetime import datetime, timezone

KEEP = 2


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_stamp(dest: str) -> None:
    """Temp file plus atomic replace: a failed write can never leave last-snapshot empty."""
    final = os.path.join(dest, "last-snapshot")
    tmp = final + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(now() + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, final)


def snapshot(workdir: str, dest: str) -> bool:
    src = os.path.join(workdir, ".story")
    if not os.path.isdir(src):
        return True  # nothing to copy yet
    os.makedirs(dest, exist_ok=True)
    n = int(time.time() * 1000)
    new_dir = os.path.join(dest, f".story.{n}")
    tmp_dir = new_dir + ".partial"
    published = False
    try:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        shutil.copytree(src, tmp_dir, symlinks=True)
        os.rename(tmp_dir, new_dir)  # complete copy now exists under its final name
        tmp_link = os.path.join(dest, f".story.link.{n}")
        os.symlink(os.path.basename(new_dir), tmp_link)
        os.rename(tmp_link, os.path.join(dest, ".story"))  # atomic publish (replaces the old symlink)
        published = True
        write_stamp(dest)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(tmp_dir, ignore_errors=True)
        if not published:
            shutil.rmtree(new_dir, ignore_errors=True)  # never delete a directory the link already points at
        try:
            with open(os.path.join(dest, "copier-errors.log"), "a") as fh:
                fh.write(f"{now()} {'stamp' if published else 'copy'} failed: {type(exc).__name__}: {exc}\n")
        except OSError:
            pass
        return False
    # prune older snapshots, never the one currently linked
    current = os.readlink(os.path.join(dest, ".story"))
    olds = sorted(d for d in os.listdir(dest) if d.startswith(".story.") and not d.endswith(".partial") and "link" not in d and d != current)
    for d in olds[:-KEEP] if len(olds) > KEEP else []:
        shutil.rmtree(os.path.join(dest, d), ignore_errors=True)
    return True


def main(argv: list[str]) -> int:
    workdir, dest = argv[0], argv[1]
    once = "--once" in argv
    interval = 30.0
    if "--interval" in argv:
        interval = float(argv[argv.index("--interval") + 1])
    ok = snapshot(workdir, dest)
    if once:
        return 0 if ok else 1
    while True:
        time.sleep(interval)
        snapshot(workdir, dest)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
