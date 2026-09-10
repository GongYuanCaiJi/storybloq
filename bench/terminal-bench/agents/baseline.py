"""Arm A0: harbor's own Claude Code agent plus isolation checks and the fixed no-user sentence.
No storybloq anywhere in the container."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from agents.common import (
    COMPLIANCE_MARKER,
    POST_RUN_CHECK_TIMEOUT,
    InfraError,
    Manifest,
    Shell,
    assert_effective_config,
    check_env_allowlist,
    check_pins,
    ensure_clean_home,
    install_claude_from_artifacts,
    record_infra_failure,
    record_started,
    run_bounded,
    write_file_command,
)

BENCH_ROOT = Path(__file__).resolve().parents[1]
INSTRUCTION_SUFFIX = (BENCH_ROOT / "agents" / "instruction.txt").read_text(encoding="utf-8").strip()


def render_instruction(instruction: str) -> str:
    """Task text byte for byte, then a blank line and the shared suffix. Nothing stripped."""
    return f"{instruction}\n\n{INSTRUCTION_SUFFIX}\n"


class StorybloqBaseline(ClaudeCode):
    ARM = "A0"

    @staticmethod
    def name() -> str:
        return "storybloq-baseline"

    def __init__(self, logs_dir: Path, manifest: str | None = None, *args: Any, **kwargs: Any):
        super().__init__(logs_dir, *args, **kwargs)
        self.manifest = Manifest.load(manifest, BENCH_ROOT)
        check_pins(self.manifest, arm=self.ARM, claude_version_kwarg=self._version, model_name=self.model_name)
        check_env_allowlist(self.extra_env, self.ARM)

    def _config_dir(self) -> str:
        return (self.environment_logs_dir / "sessions").as_posix()

    def _shell(self, environment: BaseEnvironment) -> Shell:
        return Shell(lambda **kw: self.exec_as_agent(environment, kw["command"], env=kw.get("env"), timeout_sec=kw.get("timeout_sec")))

    async def install(self, environment: BaseEnvironment) -> None:
        sh = self._shell(environment)
        try:
            self._install_versions = await install_claude_from_artifacts(sh, environment, lambda cmd: self.exec_as_root(environment, cmd), self.manifest)
            await super().install(environment)  # finds the pinned claude and skips its bootstrap
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001  harbor's own claude install failed: pre-start, marker written
            await run_bounded(record_infra_failure(sh, self.environment_logs_dir, exc), 15)
            raise

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        sh = self._shell(environment)
        logs = self.environment_logs_dir
        try:
            await ensure_clean_home(sh)  # the parent copies ~/.claude/skills into the config dir: a clean home is the pre-start isolation check
            versions = {"manifest_sha256": self.manifest.sha256, "arm": self.ARM, "harbor_version": self.manifest.data.get("harbor_version"),
                        "executor_model": self.manifest.data.get("executor_model"), **getattr(self, "_install_versions", {})}
            await sh.must(write_file_command((logs / "versions.json").as_posix(), json.dumps(versions, sort_keys=True)), "config")
            await record_started(sh, logs)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001  anything before claude starts is pre-start
            await run_bounded(record_infra_failure(sh, logs, exc), 15)
            raise
        try:
            await super().run(render_instruction(instruction), environment, context)
        finally:
            # Post-start negative assertion, bounded. A violation here is a COMPLIANCE failure of a
            # trial that ran (it stays in the denominator, flagged); nothing in this block can
            # replace the original outcome: every step is bounded and swallows its own errors.
            await run_bounded(self._post_run_isolation_check(sh, logs), POST_RUN_CHECK_TIMEOUT + 15)

    async def _post_run_isolation_check(self, sh: Shell, logs) -> None:
        try:
            await asyncio.wait_for(assert_effective_config(sh, self._config_dir(), {"CLAUDE_CONFIG_DIR": self._config_dir()}, expect_storybloq=False, skill_sha256=None, expect_bridge=False), POST_RUN_CHECK_TIMEOUT)
            return
        except asyncio.CancelledError:
            raise
        except InfraError as exc:
            detail = str(exc)[:2000]
        except asyncio.TimeoutError:
            detail = f"isolation check exceeded {POST_RUN_CHECK_TIMEOUT}s"
        except Exception as exc:  # noqa: BLE001
            detail = f"isolation check failed: {type(exc).__name__}"
        try:
            await sh.run(write_file_command((logs / COMPLIANCE_MARKER).as_posix(), json.dumps({"kind": "isolation", "detail": detail})), timeout=10)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            pass
