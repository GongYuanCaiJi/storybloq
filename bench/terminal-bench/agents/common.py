"""Shared adapter pieces: manifest loading, env allow-list, effective-config assertions,
pre-start failure markers, bounded cleanup. Every container command runs through
`exec_as_agent` so it inherits the harness's default user and cwd (the task WORKDIR)."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Awaitable, Callable

ALLOWED_ENV = {"ANTHROPIC_API_KEY", "OPENAI_API_KEY"}
FORBIDDEN_ENV_RE = re.compile(r"(_API_KEY$|_TOKEN$|^CLAUDE_|^CODEX_|^RB_)")
ADAPTER_FILES = (
    "agents/common.py", "agents/baseline.py", "agents/storybloq_auto.py", "agents/instruction.txt",
    "agents/mkticket.py", "agents/telemetry-copier.py", "report/parse.py", "report/prices.json",
    "report/build_report.py", "report/seed.py", "seed/pilot-tasks.json", "README.md",
)
CLEANUP_STEP_TIMEOUT = 60
CLEANUP_PHASE_TIMEOUT = 150
POST_RUN_CHECK_TIMEOUT = 60
INFRA_MARKER = "infra-failure.json"   # written by the adapter BEFORE claude ever starts
STARTED_MARKER = "started.json"       # written immediately before the parent run() call
COMPLIANCE_MARKER = "compliance-error.json"  # post-start violation; the row stays in the denominator


class InfraError(RuntimeError):
    """Pre-start failure. parse.py classifies a trial as infra-excluded ONLY from the
    infra-failure.json marker (see record_infra_failure), never from this message."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"infra:{reason} {detail}".strip())
        self.reason = reason
        self.detail = detail


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def check_env_allowlist(extra_env: dict[str, str], arm: str) -> None:
    allowed = {"ANTHROPIC_API_KEY"} | ({"OPENAI_API_KEY"} if arm in ("A2", "A4") else set())
    for k in extra_env:
        if k in allowed:
            continue
        if FORBIDDEN_ENV_RE.search(k):
            raise InfraError("env-allowlist", f"{k} is not an allowed credential or client variable")


def parse_semver(text: str) -> str | None:
    m = re.search(r"(\d+\.\d+\.\d+)", text or "")
    return m.group(1) if m else None


@dataclass
class Manifest:
    path: Path
    data: dict[str, Any]
    bench_root: Path

    @classmethod
    def load(cls, path: str | Path | None, bench_root: Path) -> "Manifest":
        if not path:
            raise InfraError("manifest", "no manifest given (--ak manifest=<run-manifest.json>)")
        p = Path(path)
        if not p.exists():
            raise InfraError("manifest", f"{p} missing")
        data = json.loads(p.read_text())
        if data.get("kind") != "run":
            raise InfraError("manifest", f"{p} is not a frozen run manifest (kind={data.get('kind')!r})")
        m = cls(p, data, bench_root)
        m.verify_adapter_hashes()
        return m

    @property
    def sha256(self) -> str:
        """Identity of the manifest = hash of the file bytes (freeze.py prints the same)."""
        return sha256_file(self.path)

    def verify_adapter_hashes(self) -> None:
        recorded = self.data.get("adapter_files") or {}
        for rel in ADAPTER_FILES:
            f = self.bench_root / rel
            if not f.exists():
                raise InfraError("manifest", f"adapter file missing: {rel}")
            if recorded.get(rel) != sha256_file(f):
                raise InfraError("manifest", f"adapter file changed since freeze: {rel}")

    def artifact(self, name: str) -> dict[str, Any]:
        a = (self.data.get("artifacts") or {}).get(name)
        if not a:
            raise InfraError("artifact", f"{name} not in manifest")
        return a

    def install_project(self, arm: str) -> dict[str, Any]:
        inst = (self.data.get("install") or {}).get(arm)
        if not inst:
            raise InfraError("manifest", f"no install project for arm {arm}")
        return inst

    def require(self, key: str) -> Any:
        v = self.data.get(key)
        if v in (None, ""):
            raise InfraError("manifest", f"manifest lacks {key}")
        return v


def check_pins(manifest: Manifest, *, arm: str, claude_version_kwarg: str | None, model_name: str | None) -> None:
    """The parent ClaudeCode gets its version and model from harbor kwargs; both must equal the pins."""
    pin = manifest.require("claude_code_version")
    if claude_version_kwarg != pin:
        raise InfraError("manifest", f"--ak version={claude_version_kwarg!r} != manifest claude_code_version {pin!r}")
    exp = manifest.require("executor_model")
    got = (model_name or "").split("/", 1)[-1]
    if got != exp:
        raise InfraError("manifest", f"-m {model_name!r} != manifest executor_model {exp!r}")
    if arm in ("A2", "A4"):
        manifest.require("codex_version")
        manifest.require("reviewer_model")


@dataclass
class ExecResult:
    return_code: int
    stdout: str
    stderr: str


ExecFn = Callable[..., Awaitable[Any]]


@dataclass
class Shell:
    """Thin wrapper over environment.exec so tests can substitute a recorder.
    `run` never raises on a non-zero exit; `must` raises InfraError(reason)."""
    exec_fn: ExecFn
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def run(self, command: str, env: dict[str, str] | None = None, timeout: float | None = None) -> ExecResult:
        self.calls.append({"command": command, "env": dict(env or {}), "timeout": timeout})
        try:
            r = await self.exec_fn(command=command, env=env, timeout_sec=timeout)
        except (asyncio.CancelledError, AssertionError):
            raise  # cancellation, and a test double's refusal, are never turned into a return code
        except Exception as exc:  # harbor's _exec raises on rc != 0; keep the shell non-raising
            rc = getattr(exc, "return_code", None)
            return ExecResult(int(rc) if isinstance(rc, int) else 1, getattr(exc, "stdout", "") or "", f"{type(exc).__name__}: {exc}"[:2000])
        return ExecResult(getattr(r, "return_code", 0), getattr(r, "stdout", "") or "", getattr(r, "stderr", "") or "")

    async def must(self, command: str, reason: str, env: dict[str, str] | None = None, timeout: float | None = None) -> ExecResult:
        r = await self.run(command, env, timeout)
        if r.return_code != 0:
            raise InfraError(reason, f"{command[:120]} -> rc={r.return_code} {r.stderr[-300:]}")
        return r


def write_file_command(path: str, content: str) -> str:
    """Shell that writes `content` to `path` byte for byte (printf %s with a quoted argument)."""
    return f"printf '%s' {shlex.quote(content)} > {shlex.quote(path)}"


async def write_json(sh: Shell, path: PurePosixPath | str, payload: Any, env: dict[str, str] | None = None) -> None:
    await sh.run(write_file_command(str(path), json.dumps(payload, sort_keys=True)), env, timeout=10)


async def record_infra_failure(sh: Shell, logs_dir: PurePosixPath, exc: BaseException) -> None:
    """The ONLY thing the parser accepts as a pre-start infra exclusion. Any exception raised
    before claude starts is pre-start, InfraError or not; the reason names its class."""
    if isinstance(exc, InfraError):
        payload = {"reason": exc.reason, "detail": exc.detail[:2000]}
    else:
        payload = {"reason": f"pre-start-error:{type(exc).__name__}", "detail": str(exc)[:2000]}
    await write_json(sh, logs_dir / INFRA_MARKER, payload)


async def record_started(sh: Shell, logs_dir: PurePosixPath, env: dict[str, str] | None = None) -> None:
    await sh.must(f"date -u +%Y-%m-%dT%H:%M:%SZ > {shlex.quote((logs_dir / STARTED_MARKER).as_posix())}", "config", env, timeout=10)


NODE_REMOTE = PurePosixPath("/opt/node")
CLAUDE_REMOTE = PurePosixPath("/opt/claude")


async def install_claude_from_artifacts(sh: Shell, environment: Any, root_exec: Callable[[str], Awaitable[Any]], manifest: "Manifest") -> dict[str, str]:
    """Install the pinned Node runtime and the locked Claude Code project from manifest artifacts.
    No network resolution: the node tarball is a checksum-verified file from the manifest, and
    Claude Code comes from a package-lock whose integrity hashes pin every byte (npm ci).
    Harbor's own bootstrap installer (a Bun binary) is never used: it segfaults under qemu on
    the amd64 task images. Returns the versions observed; raises InfraError on any mismatch."""
    node = manifest.require("node")
    inst = manifest.install_project("claude")
    pin = manifest.require("claude_code_version")
    local_tgz = Path(node["path"])
    if not local_tgz.exists() or sha256_file(local_tgz) != node["sha256"]:
        raise InfraError("artifact", f"node tarball {local_tgz} missing or differs from manifest")
    await root_exec(f"mkdir -p {NODE_REMOTE} {CLAUDE_REMOTE} && chmod 0777 {NODE_REMOTE} {CLAUDE_REMOTE}")
    remote_tgz = f"{NODE_REMOTE}/node.tgz"
    await environment.upload_file(local_tgz, remote_tgz)
    r = await sh.must(f"sha256sum {remote_tgz} | cut -d' ' -f1", "artifact")
    if r.stdout.strip() != node["sha256"]:
        raise InfraError("artifact", f"uploaded node tarball sha {r.stdout.strip()[:12]} != manifest {node['sha256'][:12]}")
    await root_exec(f"tar -xzf {remote_tgz} -C {NODE_REMOTE} --strip-components=1 && ln -sf {NODE_REMOTE}/bin/node /usr/local/bin/node && ln -sf {NODE_REMOTE}/bin/npm /usr/local/bin/npm && ln -sf {NODE_REMOTE}/bin/npx /usr/local/bin/npx")
    r = await sh.must("node --version", "node")
    if r.stdout.strip() != f"v{node['version']}":
        raise InfraError("node", f"node --version {r.stdout.strip()!r} != pinned v{node['version']}")
    local_dir = Path(inst["dir"])
    for fname, key in (("package.json", "package_json_sha256"), ("package-lock.json", "package_lock_sha256")):
        if sha256_file(local_dir / fname) != inst.get(key):
            raise InfraError("manifest", f"claude install/{fname} differs from the frozen manifest")
        await environment.upload_file(local_dir / fname, f"{CLAUDE_REMOTE}/{fname}")
        r = await sh.must(f"sha256sum {CLAUDE_REMOTE}/{fname} | cut -d' ' -f1", "artifact")
        if r.stdout.strip() != inst[key]:
            raise InfraError("artifact", f"uploaded {fname} sha differs from manifest")
    # --ignore-scripts: the lockfile's integrity hashes cover every installed byte; lifecycle scripts could
    # fetch or generate anything, so they never run. The pinned executable is then verified below.
    r = await sh.run(f"cd {CLAUDE_REMOTE} && npm ci --ignore-scripts --no-audit --no-fund", timeout=900)
    if r.return_code != 0:
        raise InfraError("artifact", f"npm ci (claude) rc={r.return_code}: {(r.stderr or r.stdout)[-400:]}")
    await root_exec(f"ln -sf {CLAUDE_REMOTE}/node_modules/.bin/claude /usr/local/bin/claude")
    r = await sh.must("claude --version", "artifact")
    got = parse_semver(r.stdout)
    if got != pin:
        raise InfraError("artifact", f"claude --version {r.stdout.strip()!r} != pin {pin}")
    return {"claude_code_version": got, "claude_install_method": "artifact", "node_version": f"v{node['version']}", "node_sha256": node["sha256"]}


async def ensure_clean_home(sh: Shell) -> None:
    r = await sh.must('for p in ~/.claude/skills ~/.claude/settings.json ~/.claude.json ~/.codex; do [ -e "$p" ] && echo "$p"; done; true', "dirty-home")
    if r.stdout.strip():
        raise InfraError("dirty-home", r.stdout.strip().replace("\n", ","))


async def capture_workdir(sh: Shell) -> str:
    r = await sh.must("pwd", "config")
    wd = r.stdout.strip()
    if not wd.startswith("/"):
        raise InfraError("config", f"pwd returned {wd!r}")
    return wd


async def capture_base_env(sh: Shell) -> dict[str, str]:
    """HOME and PATH as the container's default user sees them (values, not `$` references)."""
    r = await sh.must('printf "%s\\n%s\\n" "$HOME" "$PATH"', "config")
    lines = r.stdout.splitlines()
    if len(lines) < 2 or not lines[0].startswith("/") or not lines[1]:
        raise InfraError("config", f"cannot resolve HOME/PATH: {r.stdout[:100]!r}")
    return {"HOME": lines[0], "PATH": lines[1]}


async def preflight_task_state(sh: Shell, workdir: str) -> dict[str, Any]:
    r = await sh.run(f'cd {shlex.quote(workdir)} && ([ -e .story ] && echo STORY_PRESENT); (command -v git >/dev/null && echo GIT=yes || echo GIT=no); (node --version 2>/dev/null || echo NODE=none)')
    out = r.stdout
    if "STORY_PRESENT" in out:
        raise InfraError("task-state", f".story already exists in {workdir}")
    node = next((l for l in out.splitlines() if l.startswith("v")), None)
    if node is None or int(node[1:].split(".")[0]) < 20:
        raise InfraError("node", f"node version {node}")
    return {"git": "GIT=yes" in out, "node": node}


HOOK_EVENTS = {"PreCompact", "SessionStart", "SessionEnd", "Stop", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "SubagentStop"}


def _hooks_mention(settings: Any, needle: str) -> bool:
    """True only when every hook entry is structurally valid (known event, list of matchers, each
    with a list of {type: "command", command: str} hooks, none disabled) and at least one command
    invokes `needle` as a program (first word, or path ending in /needle)."""
    if not isinstance(settings, dict) or settings.get("disableAllHooks") is True:
        return False
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict) or not hooks:
        return False
    found = False
    for event, entries in hooks.items():
        if event not in HOOK_EVENTS or not isinstance(entries, list):
            return False
        for entry in entries:
            inner = entry.get("hooks") if isinstance(entry, dict) else None
            if not isinstance(inner, list) or entry.get("disabled") is True:
                return False
            for h in inner:
                if not isinstance(h, dict) or h.get("type") != "command" or not isinstance(h.get("command"), str) or h.get("disabled") is True:
                    return False
                prog = h["command"].split()[0] if h["command"].split() else ""
                if prog == needle or prog.endswith("/" + needle):
                    found = True
    return found


def _mcp_connected(listing: str, name: str) -> bool:
    for line in listing.splitlines():
        if line.strip().startswith(f"{name}:"):
            return "Connected" in line and "Failed" not in line
    return False


async def assert_effective_config(sh: Shell, config_dir: str, env: dict[str, str], *, expect_storybloq: bool, skill_sha256: str | None, expect_bridge: bool) -> dict[str, Any]:
    q = shlex.quote(config_dir)
    if not expect_storybloq:
        # Exit status is meaningful: an absent skills dir is the clean case, a failing `ls` on a
        # present one is an error (exit 3), and the existence tests never fail the command.
        r = await sh.must(f'if [ -e {q}/skills ]; then ls -A {q}/skills || exit 3; fi; if [ -e {q}/settings.json ]; then echo SETTINGS; fi; if [ -e {q}/.claude.json ]; then echo CLAUDEJSON; fi', "config", env)
        if r.stdout.strip():
            raise InfraError("config", f"baseline config dir not empty: {r.stdout.strip()[:200]}")
        return {"skills": "empty"}
    r = await sh.must(f"sha256sum {q}/skills/story/SKILL.md | cut -d' ' -f1", "config", env)
    measured = r.stdout.strip()
    if skill_sha256 and measured != skill_sha256:
        raise InfraError("config", f"installed SKILL.md {measured[:12]} != manifest {skill_sha256[:12]}")
    r = await sh.must(f"cat {q}/settings.json", "config", env)
    try:
        settings = json.loads(r.stdout)
    except json.JSONDecodeError as exc:
        raise InfraError("config", f"settings.json is not JSON: {exc}") from None
    if not _hooks_mention(settings, "storybloq"):
        raise InfraError("config", "settings.json carries no structurally valid storybloq hook")
    r = await sh.must("claude mcp list 2>&1", "config", env)
    if not _mcp_connected(r.stdout, "storybloq"):
        raise InfraError("config", f"storybloq MCP not connected: {r.stdout.strip()[:200]}")
    if expect_bridge and not _mcp_connected(r.stdout, "codex-bridge"):
        raise InfraError("config", f"codex-bridge MCP not connected: {r.stdout.strip()[:200]}")
    return {"skill_sha256": measured}


async def bounded_cleanup(sh: Shell, steps: list[tuple[str, str]], env: dict[str, str], logs_dir: PurePosixPath) -> list[dict[str, str]]:
    """Run each (name, command) under CLEANUP_STEP_TIMEOUT inside CLEANUP_PHASE_TIMEOUT.
    The phase task is cancelled and awaited on timeout and on outer cancellation, so no
    command outlives this call. Never raises except to propagate an outer CancelledError
    (after the phase task has finished); records to collect-errors.json when anything failed."""
    errors: list[dict[str, str]] = []

    async def phase() -> None:
        for name, cmd in steps:
            try:
                r = await sh.run(f"timeout {CLEANUP_STEP_TIMEOUT} sh -c {shlex.quote(cmd)}", env, timeout=CLEANUP_STEP_TIMEOUT + 5)
                if r.return_code != 0:
                    errors.append({"step": name, "error": f"rc={r.return_code} {r.stderr[-200:]}"})
            except asyncio.CancelledError:
                errors.append({"step": name, "error": "cancelled"})
                raise
            except Exception as exc:  # noqa: BLE001
                errors.append({"step": name, "error": repr(exc)[:200]})

    task = asyncio.ensure_future(phase())
    cancelled_outer = False
    phase_error: str | None = None
    try:
        await asyncio.wait_for(asyncio.shield(task), CLEANUP_PHASE_TIMEOUT)
    except asyncio.TimeoutError:
        phase_error = f"cleanup exceeded {CLEANUP_PHASE_TIMEOUT}s"
    except asyncio.CancelledError:
        cancelled_outer = True
        phase_error = "cancelled during cleanup"
    finally:
        if await _cancel_and_drain(task):
            cancelled_outer = True
            phase_error = phase_error or "cancelled during cleanup"
    if phase_error:
        errors.append({"step": "phase", "error": phase_error})
    if errors:
        await run_bounded(write_json(sh, logs_dir / "collect-errors.json", errors, env), 10)
    if cancelled_outer:
        raise asyncio.CancelledError()
    return errors


async def _cancel_and_drain(task: "asyncio.Future[Any]") -> bool:
    """Cancel `task` and wait until it has actually finished. The wait is unbounded on purpose:
    a task that is still running has not released its container command, so returning early
    would let it race harbor's teardown. Every command the adapters issue carries its own
    timeout_sec, which is what bounds this wait. Repeated cancellation covers a task that
    catches the first CancelledError inside a nested await. Returns True when the CALLER was
    cancelled while draining; the caller must then re-raise CancelledError once its child is done."""
    caller_cancelled = False
    while not task.done():
        task.cancel()
        try:
            await asyncio.shield(asyncio.wait({task}, timeout=5))
        except asyncio.CancelledError:
            caller_cancelled = True  # keep draining our child first, propagate afterwards
    return caller_cancelled


async def run_bounded(coro: Awaitable[Any], timeout: float) -> Any:
    """Await `coro` for at most `timeout` seconds; on expiry or outer cancellation the task is
    cancelled AND drained before returning, so nothing outlives the call. Never raises except
    to propagate an outer CancelledError. Returns the result, or None on timeout/error."""
    task = asyncio.ensure_future(coro)
    outer_cancel = False
    result = None
    try:
        result = await asyncio.wait_for(asyncio.shield(task), timeout)
    except asyncio.CancelledError:
        outer_cancel = True
    except (asyncio.TimeoutError, Exception):  # noqa: BLE001
        pass
    finally:
        if await _cancel_and_drain(task):
            outer_cancel = True
    if outer_cancel:
        raise asyncio.CancelledError()
    return result
