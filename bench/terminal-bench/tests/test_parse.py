"""Hand-audited expectations for tests/fixtures/trial-a2 (see the fixture files themselves).

Executor (Claude):
  main file sid-main.jsonl: msg-1 streamed twice (first output 1, LAST output 50) and msg-2
  (input 2, cache_read 110, cache_write_1h 40, output 30); the last main usage gives context.
  subagent agent-a1.jsonl: sub-1 and sub-2 on haiku (input 500+7, output 20+7).
Reviewer (Codex):
  rollout A (gpt-6-astra, two turns): input 1000+2000, cached 400+1500, output 100+200, plus
  cumulative token_count events (3000/1900/300 at the end) that must never be counted.
  rollout B: turn u1 on gpt-6-astra (300/0/30) with the SAME response repeated (must count
  once, diagnostic duplicate-response), turn u2 on gpt-5.6-sol (50/0/5).
Story: two codex rounds; plan round's reviewerSessionId matches rollout A -> compliance reviewed.
Markers: started.json present, no infra-failure.json.
"""
from __future__ import annotations

import io
import json
import shutil
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from report.parse import (  # noqa: E402
    check_a0_isolation,
    cost_usd,
    parse_claude_sessions,
    parse_codex_home,
    parse_story,
    parse_trial,
)

FX = ROOT / "tests" / "fixtures" / "trial-a2"
INSTRUCTION = (FX / "instruction.txt").read_text(encoding="utf-8")


def copy_fixture(tmp_path: Path) -> Path:
    t = tmp_path / "trial"
    shutil.copytree(FX, t)
    return t


def test_claude_per_model_sums_last_usage_per_unit():
    c = parse_claude_sessions(FX / "agent" / "sessions")
    s = c.per_model["claude-sonnet-5"].as_dict()
    assert s["input"] == 12
    assert s["cache_read"] == 110
    assert s["cache_write_5m"] == 100
    assert s["cache_write_1h"] == 40
    assert s["output"] == 80  # m1 (input only) and m2 (first usage: 1+30=31) both break this
    assert s["responses"] == 2
    assert c.coverage == "complete" and c.unpriceable == []


def test_claude_context_is_last_main_usage():
    c = parse_claude_sessions(FX / "agent" / "sessions")
    assert c.context_at_exit == 2 + 110 + 0 + 40  # m2b would take msg-1's first usage: 110
    assert c.main_file == "projects/-app/sid-main.jsonl"


def test_claude_subagent_model_is_separate_and_recursive():
    c = parse_claude_sessions(FX / "agent" / "sessions")
    assert set(c.per_model) == {"claude-sonnet-5", "claude-haiku-4-5-20251001"}  # m3 collapses
    h = c.per_model["claude-haiku-4-5-20251001"].as_dict()
    assert h["input"] == 507 and h["output"] == 27  # m4 (non-recursive glob) loses this file


def test_claude_duplicate_id_copy_counts_once_conflict_is_incomplete(tmp_path):
    t = copy_fixture(tmp_path)
    sub = t / "agent" / "sessions" / "projects" / "-app" / "sid-main" / "subagents" / "agent-a1.jsonl"
    main_lines = (t / "agent" / "sessions" / "projects" / "-app" / "sid-main.jsonl").read_text().splitlines()
    msg2 = next(l for l in main_lines if '"id":"msg-2"' in l)
    sub.write_text(sub.read_text() + msg2 + "\n")  # identical copy of msg-2 in the subagent file
    c = parse_claude_sessions(t / "agent" / "sessions")
    assert c.per_model["claude-sonnet-5"].as_dict()["output"] == 80  # not 110
    assert c.coverage == "complete" and any(d.startswith("duplicate-id-copy:msg-2") for d in c.diagnostics)
    conflict = json.loads(msg2)
    conflict["message"]["usage"]["output_tokens"] = 999
    sub.write_text(sub.read_text().replace(msg2 + "\n", json.dumps(conflict) + "\n"))
    c = parse_claude_sessions(t / "agent" / "sessions")
    assert c.coverage == "incomplete" and any(d.startswith("duplicate-id-conflict:msg-2") for d in c.diagnostics)
    same_counts_other_model = dict(json.loads(msg2))
    same_counts_other_model["message"] = {**same_counts_other_model["message"], "model": "claude-haiku-4-5-20251001"}
    sub.write_text(sub.read_text().replace(json.dumps(conflict) + "\n", json.dumps(same_counts_other_model) + "\n"))
    c = parse_claude_sessions(t / "agent" / "sessions")
    assert c.coverage == "incomplete"  # identical counts under a different model id are not the same record


def test_codex_cached_exceeding_input_is_invalid(tmp_path):
    t = copy_fixture(tmp_path)
    fb = next((t / "agent" / "codex-home" / "sessions" / "2026" / "09" / "09").glob("rollout-*bbbbbbbb*.jsonl"))
    fb.write_text(fb.read_text().replace('"input_tokens":50,"cached_input_tokens":0', '"input_tokens":50,"cached_input_tokens":60'))
    x = parse_codex_home(t / "agent" / "codex-home")
    assert x.coverage == "incomplete" and any(d.startswith("usage-invalid:bbbbbbbb") for d in x.diagnostics)
    assert "gpt-5.6-sol" not in x.per_model


def test_story_malformed_reviews_list_is_diagnosed(tmp_path):
    t = copy_fixture(tmp_path)
    st = t / "agent" / "story-live" / ".story" / "sessions" / "s1" / "state.json"
    s = json.loads(st.read_text())
    s["reviews"]["plan"] = "corrupt"
    st.write_text(json.dumps(s))
    st_ = parse_story(t / "agent")
    assert "reviews-malformed:plan" in st_.diagnostics and [r["stage"] for r in st_.rounds] == ["code"]
    r = parse_trial(t, "A2", INSTRUCTION)  # never raises
    assert r.statuses["compliance"] == "no-review"


def test_claude_malformed_line_and_missing_field_make_coverage_incomplete(tmp_path):
    t = copy_fixture(tmp_path)
    main = t / "agent" / "sessions" / "projects" / "-app" / "sid-main.jsonl"
    main.write_bytes(main.read_bytes() + b'{"type":"assistant","message":{"id":"msg-9","model":"claude-sonnet-5","usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_inp')
    c = parse_claude_sessions(t / "agent" / "sessions")
    assert c.coverage == "incomplete" and any(d.startswith("truncated-tail:") for d in c.diagnostics)
    assert c.per_model["claude-sonnet-5"].as_dict()["output"] == 80  # readable records still observed
    t2 = copy_fixture(tmp_path / "b")
    main = t2 / "agent" / "sessions" / "projects" / "-app" / "sid-main.jsonl"
    main.write_text(main.read_text().replace('"cache_read_input_tokens":110,', ""))
    c = parse_claude_sessions(t2 / "agent" / "sessions")
    assert c.coverage == "incomplete" and any(d.startswith("usage-missing-field:cache_read_input_tokens") for d in c.diagnostics)


def test_claude_cache_tier_unknown_is_unpriceable(tmp_path):
    t = copy_fixture(tmp_path)
    main = t / "agent" / "sessions" / "projects" / "-app" / "sid-main.jsonl"
    main.write_text(main.read_text().replace(',"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":0}', ""))
    c = parse_claude_sessions(t / "agent" / "sessions")
    assert c.coverage == "complete" and "cache-tier-unknown" in c.unpriceable
    r = parse_trial(t, "A2", INSTRUCTION)
    assert r.executor_coverage == "unpriceable"


def test_codex_per_response_units_join_turn_model():
    x = parse_codex_home(FX / "agent" / "codex-home")
    a = x.per_model["gpt-6-astra"].as_dict()
    assert a["input"] == 3300  # m5 (count the repeated response) gives 3600; m8 (token_count) gives more
    assert a["cached_input"] == 1900
    assert a["output"] == 330
    assert a["responses"] == 3
    b = x.per_model["gpt-5.6-sol"].as_dict()  # m7 attributes this turn to gpt-6-astra
    assert b["input"] == 50 and b["output"] == 5
    assert any(d.startswith("duplicate-response:bbbbbbbb") for d in x.diagnostics)
    assert x.rollouts["aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa"]["responses"] == 2
    assert x.coverage == "complete"


def test_codex_empty_rollout_and_missing_model_join(tmp_path):
    t = copy_fixture(tmp_path)
    d = t / "agent" / "codex-home" / "sessions" / "2026" / "09" / "09"
    (d / "rollout-2026-09-09T00-02-00-cccccccc-cccc-7ccc-cccc-cccccccccccc.jsonl").write_text("")
    x = parse_codex_home(t / "agent" / "codex-home")
    assert "rollout-empty:cccccccc-cccc-7ccc-cccc-cccccccccccc" in x.diagnostics
    assert x.coverage == "incomplete"  # populated rollouts plus an empty one: the aggregate is not complete
    assert x.per_model["gpt-6-astra"].as_dict()["input"] == 3300
    r = parse_trial(t, "A2", INSTRUCTION)
    assert r.reviewer_coverage == "incomplete"
    fa = next(d.glob("rollout-*aaaaaaaa*.jsonl"))
    fa.write_text(fa.read_text().replace('{"type":"turn_context","payload":{"turn_id":"t2","model":"gpt-6-astra"}}\n', ""))
    x = parse_codex_home(t / "agent" / "codex-home")
    assert x.coverage == "incomplete" and any(d.startswith("usage-without-turn-model:aaaaaaaa") for d in x.diagnostics)


def _story_archive(agent_dir: Path, prefix: str) -> None:
    live = agent_dir / "story-live"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for p in sorted(live.rglob("*")):
            if p.is_file():
                tf.add(p, arcname=prefix + str(p.relative_to(live)))
    (agent_dir / "story.tgz").write_bytes(buf.getvalue())
    shutil.rmtree(live)


@pytest.mark.parametrize("prefix", ["", "./"])
def test_story_rounds_and_exit_state_from_live_and_archive(tmp_path, prefix):
    live = parse_story(FX / "agent")
    assert live.source == "story-live"
    t = copy_fixture(tmp_path)
    _story_archive(t / "agent", prefix)
    s = parse_story(t / "agent")
    assert s.source == "story.tgz"
    for st in (live, s):
        assert st.exit_state == "SESSION_END" and st.status == "completed"
        assert [r["stage"] for r in st.rounds] == ["plan", "code"]
        assert st.rounds[0]["reviewerSessionId"] == "aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa"
        assert st.ticket_description == INSTRUCTION
        assert "no-session-state" not in st.diagnostics
    r = parse_trial(t, "A2", INSTRUCTION)
    assert r.statuses["compliance"] == "reviewed" and r.review_rounds == 2


def test_story_live_reads_through_the_published_symlink(tmp_path):
    t = copy_fixture(tmp_path)
    live = t / "agent" / "story-live"
    (live / ".story").rename(live / ".story.1")
    (live / ".story").symlink_to(".story.1")
    s = parse_story(t / "agent")
    assert s.source == "story-live" and s.exit_state == "SESSION_END" and s.ticket_description == INSTRUCTION


def test_story_truncated_archive_falls_back_to_live(tmp_path):
    t = copy_fixture(tmp_path)
    (t / "agent" / "story.tgz").write_bytes(b"\x1f\x8b\x08\x00garbage")
    s = parse_story(t / "agent")
    assert s.source == "story-live" and any(d.startswith("story-archive-unreadable") for d in s.diagnostics)
    assert s.exit_state == "SESSION_END"
    st = t / "agent" / "story-live" / ".story" / "sessions" / "s1" / "state.json"
    st.write_text("{not json")
    s = parse_story(t / "agent")
    assert any(d.startswith("session-state-unreadable") for d in s.diagnostics)
    from report.parse import CredentialLeak

    with pytest.raises(CredentialLeak, match="story.tgz"):  # a partial archive cannot be cleared of credentials; the report refuses
        parse_trial(t, "A2", INSTRUCTION)
    (t / "agent" / "story.tgz").unlink()  # the adapter never leaves one: story.tgz is written outside /logs/agent and moved in whole
    r = parse_trial(t, "A2", INSTRUCTION)  # never raises once the collected set is inspectable
    assert r.statuses["compliance"] == "no-review"


def test_trial_row_statuses_and_compliance():
    r = parse_trial(FX, "A2", INSTRUCTION)
    assert r.pass_ is True and r.reward == 1.0 and r.started is True
    assert r.wall_clock_s == 330.0
    assert r.statuses["infra"] == "ok" and r.statuses["agent"] == "completed"
    assert r.statuses["compliance"] == "reviewed"
    assert r.statuses["telemetry"] == "issues:duplicate-response"
    assert "ticket-description-mismatch" not in r.diagnostics
    assert r.review_rounds == 2 and r.reviewer_attempts == 2
    assert r.harness_cost_usd == 0.0123
    assert r.context_at_exit == 152
    assert r.executor_coverage == "complete" and r.reviewer_coverage == "complete"


def test_trial_row_instruction_mismatch_is_flagged():
    r = parse_trial(FX, "A2", INSTRUCTION.rstrip("\n"))  # trailing newlines stripped = mismatch
    assert "ticket-description-mismatch" in r.diagnostics
    assert "ticket-description-mismatch" in r.statuses["telemetry"]


def test_trial_row_no_review_when_session_id_uncorrelated(tmp_path):
    t = copy_fixture(tmp_path)
    st = t / "agent" / "story-live" / ".story" / "sessions" / "s1" / "state.json"
    s = json.loads(st.read_text())
    s["reviews"]["plan"][0]["reviewerSessionId"] = "zzzzzzzz-0000-7000-0000-000000000000"
    st.write_text(json.dumps(s))
    r = parse_trial(t, "A2", INSTRUCTION)
    assert r.statuses["compliance"] == "no-review"


def test_trial_row_timeout_without_result_event(tmp_path):
    t = copy_fixture(tmp_path)
    (t / "agent" / "claude-code.txt").write_text('{"type":"system","subtype":"init"}\n')
    res = json.loads((t / "result.json").read_text())
    res["exception_info"] = {"exception_type": "AgentTimeoutError", "exception_message": "Agent execution timed out after 900 seconds"}
    res["verifier_result"] = None
    (t / "result.json").write_text(json.dumps(res))
    r = parse_trial(t, "A2", INSTRUCTION)
    assert r.statuses["agent"] == "timeout" and r.statuses["infra"] == "ok"
    assert r.statuses["verifier"] == "missing" and r.pass_ is None
    assert r.harness_cost_usd is None


def test_trial_row_infra_only_from_pre_start_marker(tmp_path):
    # Genuine pre-start failure: marker, no started.json, no transcripts.
    t = tmp_path / "pre"
    (t / "agent").mkdir(parents=True)
    (t / "agent" / "infra-failure.json").write_text(json.dumps({"reason": "artifact", "detail": "sha mismatch"}))
    (t / "result.json").write_text(json.dumps({"task_name": "x", "exception_info": {"exception_type": "RuntimeError", "exception_message": "infra:artifact sha mismatch"}}))
    r = parse_trial(t, "A2", INSTRUCTION)
    assert r.statuses["infra"] == "artifact" and r.statuses["agent"] == "not-started" and r.started is False
    # A STARTED trial whose exception text looks like infra stays in the denominator.
    t2 = copy_fixture(tmp_path / "s")
    res = json.loads((t2 / "result.json").read_text())
    res["exception_info"] = {"exception_type": "RuntimeError", "exception_message": "Agent failed: infra:artifact sha mismatch"}
    (t2 / "result.json").write_text(json.dumps(res))
    r = parse_trial(t2, "A2", INSTRUCTION)
    assert r.statuses["infra"] == "ok" and r.statuses["agent"] == "error:RuntimeError"
    # Marker written after start: not an exclusion either, and diagnosed.
    (t2 / "agent" / "infra-failure.json").write_text(json.dumps({"reason": "config"}))
    r = parse_trial(t2, "A2", INSTRUCTION)
    assert r.statuses["infra"] == "ok" and "infra-marker-after-start" in r.diagnostics
    # No marker at all: start-unknown, which build() refuses.
    (t2 / "agent" / "infra-failure.json").unlink()
    (t2 / "agent" / "started.json").unlink()
    r = parse_trial(t2, "A2", INSTRUCTION)
    assert "start-unknown" in r.diagnostics and r.statuses["infra"] == "ok"


def test_trial_row_reward_domain(tmp_path):
    t = copy_fixture(tmp_path)
    res = json.loads((t / "result.json").read_text())
    for bad in (float("inf"), 2, 0.5, True):
        res["verifier_result"] = {"rewards": {"reward": bad}}
        (t / "result.json").write_text(json.dumps(res) if bad != float("inf") else json.dumps(res).replace("Infinity", "Infinity"))
        r = parse_trial(t, "A2", INSTRUCTION)
        assert r.pass_ is None and r.statuses["verifier"] == "invalid", bad
    res["verifier_result"] = {"rewards": {"reward": 0}}
    (t / "result.json").write_text(json.dumps(res))
    r = parse_trial(t, "A2", INSTRUCTION)
    assert r.pass_ is False and r.reward == 0.0


def make_config_dir_tgz(dest: Path, entries: list[tuple[str, str, bytes | None]]) -> None:
    """entries: (name, kind, target) where kind is 'f' (regular file), 'd' (directory) or
    'l' (symlink, target = the string it points at). Mirrors what `tar czf ... -C <dir> .`
    produces for A0's collected CLAUDE_CONFIG_DIR: a leading `./` on every member."""
    with tarfile.open(dest, "w:gz") as tf:
        root = tarfile.TarInfo(".")
        root.type = tarfile.DIRTYPE
        tf.addfile(root)
        for name, kind, target in entries:
            info = tarfile.TarInfo(f"./{name}")
            if kind == "f":
                data = target or b""
                info.type = tarfile.REGTYPE
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
            elif kind == "d":
                info.type = tarfile.DIRTYPE
                tf.addfile(info)
            elif kind == "l":
                info.type = tarfile.SYMTYPE
                info.linkname = target or "/etc/hosts"
                tf.addfile(info)
            else:
                raise ValueError(kind)


def test_trial_row_a0_isolation_marker(tmp_path):
    t = copy_fixture(tmp_path)
    # No artifact at all: unknown (can never be "ok" by default -- fails closed).
    r = parse_trial(t, "A0")
    assert r.statuses["compliance"] == "unknown" and r.reviewer_coverage == "n/a"
    # The invariant is narrow -- did storybloq install itself -- not "the dir is pristine". A
    # genuinely clean A0 trial's CLAUDE_CONFIG_DIR (verified against an actual successful run)
    # normally holds all of this, none of it storybloq state: ok.
    with tarfile.open(t / "agent" / "config-dir.tgz", "w:gz") as tf:
        root = tarfile.TarInfo("."); root.type = tarfile.DIRTYPE; tf.addfile(root)
        for name, kind, data in [
            (".claude.json", "f", b'{"firstStartVersion":"2.1.267"}'),
            (".last-cleanup", "f", b"2026-09-11T23:52:00Z\n"),
            ("policy-limits.json", "f", b"{}"),
            ("remote-settings.json", "f", b"{}"),
            ("skills", "d", None),  # present but empty: not a violation
            ("backups", "d", None), ("debug", "d", None), ("projects", "d", None), ("projects/-app", "d", None),
            ("session-env", "d", None), ("sessions", "d", None), ("shell-snapshots", "d", None),
        ]:
            info = tarfile.TarInfo(f"./{name}")
            if kind == "f":
                info.type = tarfile.REGTYPE; info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
            else:
                info.type = tarfile.DIRTYPE; tf.addfile(info)
        transcript = tarfile.TarInfo("./projects/-app/8027d459.jsonl"); transcript.type = tarfile.REGTYPE; transcript.size = 0
        tf.addfile(transcript, io.BytesIO(b""))
    r = parse_trial(t, "A0")
    assert r.statuses["compliance"] == "ok" and r.statuses["infra"] == "ok"
    # A populated skills/ (storybloq's skill installed itself): violated.
    with tarfile.open(t / "agent" / "config-dir.tgz", "w:gz") as tf:
        d = tarfile.TarInfo("./skills"); d.type = tarfile.DIRTYPE; tf.addfile(d)
        nested = tarfile.TarInfo("./skills/story/SKILL.md"); nested.type = tarfile.REGTYPE; nested.size = 0
        tf.addfile(nested, io.BytesIO(b""))
    assert parse_trial(t, "A0").statuses["compliance"] == "isolation-violated"
    # settings.json at the top level (storybloq's hooks/MCP registration): violated.
    make_config_dir_tgz(t / "agent" / "config-dir.tgz", [(".claude.json", "f", b"{}"), ("settings.json", "f", b"{}")])
    assert parse_trial(t, "A0").statuses["compliance"] == "isolation-violated"
    # A symlinked skills -> an arbitrary populated directory produces no skills/... members at
    # all (tar never follows a symlink into its target): violated regardless.
    with tarfile.open(t / "agent" / "config-dir.tgz", "w:gz") as tf:
        link = tarfile.TarInfo("./skills"); link.type = tarfile.SYMTYPE; link.linkname = "/some/populated/dir"
        tf.addfile(link)
    assert parse_trial(t, "A0").statuses["compliance"] == "isolation-violated"
    # A storybloq MCP registration hiding inside .claude.json's mcpServers, with no settings.json
    # and no populated skills/ at all: violated.
    make_config_dir_tgz(t / "agent" / "config-dir.tgz", [
        (".claude.json", "f", json.dumps({"mcpServers": {"storybloq": {"command": "storybloq", "args": ["--mcp"]}}}).encode()),
    ])
    assert parse_trial(t, "A0").statuses["compliance"] == "isolation-violated"
    # A non-storybloq mcpServers entry, or ordinary non-JSON-mcpServers .claude.json content, is
    # still tolerated -- the check targets storybloq specifically, not any MCP config at all.
    make_config_dir_tgz(t / "agent" / "config-dir.tgz", [
        (".claude.json", "f", json.dumps({"mcpServers": {"other-tool": {"command": "other-tool"}}}).encode()),
    ])
    assert parse_trial(t, "A0").statuses["compliance"] == "ok"
    # A storybloq MCP registration hiding under a PROJECT-scoped entry (projects.<path>.mcpServers)
    # rather than the top-level mcpServers: violated (round 33 finding).
    make_config_dir_tgz(t / "agent" / "config-dir.tgz", [
        (".claude.json", "f", json.dumps({
            "projects": {"/app": {"mcpServers": {"storybloq": {"command": "storybloq", "args": ["--mcp"]}}}}
        }).encode()),
    ])
    assert parse_trial(t, "A0").statuses["compliance"] == "isolation-violated"
    # A non-storybloq server whose free-form `env` value happens to contain the word "storybloq"
    # (e.g. an unrelated PROJECT_NAME) is NOT a violation -- only identity/execution fields
    # (name, command, args, url, type) are checked, never env (round 33 finding).
    make_config_dir_tgz(t / "agent" / "config-dir.tgz", [
        (".claude.json", "f", json.dumps({
            "mcpServers": {"other-tool": {"command": "other-tool", "env": {"PROJECT_NAME": "storybloq"}}}
        }).encode()),
    ])
    assert parse_trial(t, "A0").statuses["compliance"] == "ok"
    # .claude.json that fails to parse as JSON cannot be verified clean: violated, not skipped.
    make_config_dir_tgz(t / "agent" / "config-dir.tgz", [(".claude.json", "f", b"not json")])
    assert parse_trial(t, "A0").statuses["compliance"] == "isolation-violated"
    # An empty archive: nothing to flag either way: ok.
    make_config_dir_tgz(t / "agent" / "config-dir.tgz", [])
    assert parse_trial(t, "A0").statuses["compliance"] == "ok"
    # A zero-byte or corrupt archive fails closed as unknown, never as a silent "ok" or a crash.
    (t / "agent" / "config-dir.tgz").write_bytes(b"")
    assert check_a0_isolation(t / "agent") == "unknown"
    (t / "agent" / "config-dir.tgz").write_bytes(b"not a tar file")
    assert check_a0_isolation(t / "agent") == "unknown"


def test_trial_row_reviewer_coverage_missing_vs_verified_zero(tmp_path):
    """verified-zero needs POSITIVE evidence: readable, fully parsed session state that records
    no Codex round, plus no rollout file at all. Absence of evidence stays 'missing'."""
    t = copy_fixture(tmp_path)
    shutil.rmtree(t / "agent" / "codex-home")
    r = parse_trial(t, "A2", INSTRUCTION)
    assert r.reviewer_coverage == "missing" and r.reviewer == {}  # codex rounds recorded, rollouts gone
    st = t / "agent" / "story-live" / ".story" / "sessions" / "s1" / "state.json"
    original = json.loads(st.read_text())
    s = {**original, "reviews": {"plan": [], "code": []}}
    st.write_text(json.dumps(s))
    r = parse_trial(t, "A2", INSTRUCTION)
    assert r.reviewer_coverage == "verified-zero" and r.statuses["compliance"] == "no-review"
    # the same state, unreadable: no longer verified
    st.write_text("{corrupt")
    r = parse_trial(t, "A2", INSTRUCTION)
    assert r.reviewer_coverage == "missing"
    # reviews list malformed: not verified either (container, stage list, single entry)
    st.write_text(json.dumps({**s, "reviews": {"plan": "x", "code": []}}))
    assert parse_trial(t, "A2", INSTRUCTION).reviewer_coverage == "missing"
    st.write_text(json.dumps({**s, "reviews": "x"}))
    assert parse_trial(t, "A2", INSTRUCTION).reviewer_coverage == "missing"
    st.write_text(json.dumps({**s, "reviews": {"plan": ["x"], "code": []}}))
    r = parse_trial(t, "A2", INSTRUCTION)
    assert r.reviewer_coverage == "missing" and "reviews-malformed:plan:entry" in r.diagnostics
    # a LIVE pre-review snapshot (session not ended) proves nothing: missing, not verified zero
    st.write_text(json.dumps({**s, "state": "PLAN", "status": "in_progress"}))
    assert parse_trial(t, "A2", INSTRUCTION).reviewer_coverage == "missing"
    # state present with no rounds but an EMPTY rollout file exists: incomplete, not verified zero
    st.write_text(json.dumps(s))
    d = t / "agent" / "codex-home" / "sessions" / "2026" / "09" / "09"
    d.mkdir(parents=True)
    (d / "rollout-2026-09-09T00-02-00-cccccccc-cccc-7ccc-cccc-cccccccccccc.jsonl").write_text("")
    assert parse_trial(t, "A2", INSTRUCTION).reviewer_coverage == "incomplete"


PRICES = {
    "claude-sonnet-5": {"input": 3.0, "cache_read": 0.3, "cache_write_5m": 3.75, "cache_write_1h": 6.0, "output": 15.0},
    "gpt-6-astra": {"input": 2.0, "cached_input": 0.5, "output": 8.0},
    "gpt-5.6-sol": {"input": 1.0, "cached_input": 0.25, "output": 4.0},
}


def test_cost_anthropic_equation_and_unknown_model():
    r = parse_trial(FX, "A2", INSTRUCTION)
    cost, unknown = cost_usd(r.executor, PRICES, "anthropic")
    assert cost is None and unknown == ["model:claude-haiku-4-5-20251001"]
    only_sonnet = {"claude-sonnet-5": r.executor["claude-sonnet-5"]}
    cost, unknown = cost_usd(only_sonnet, PRICES, "anthropic")
    expected = (12 * 3.0 + 110 * 0.3 + 100 * 3.75 + 40 * 6.0 + 80 * 15.0) / 1e6
    assert cost == pytest.approx(expected) and unknown == []


def test_cost_openai_subtracts_cached_input():
    r = parse_trial(FX, "A2", INSTRUCTION)
    cost, unknown = cost_usd(r.reviewer, PRICES, "openai")
    astra = ((3300 - 1900) * 2.0 + 1900 * 0.5 + 330 * 8.0) / 1e6  # m6 bills 3300 at full price
    sol = (50 * 1.0 + 5 * 4.0) / 1e6
    assert unknown == [] and cost == pytest.approx(astra + sol)


def test_cost_missing_dimension_and_empty_usage_are_unknown():
    prices = {"gpt-6-astra": {"input": 2.0, "output": 8.0}}
    cost, unknown = cost_usd({"gpt-6-astra": {"input": 10, "cached_input": 0, "output": 1}}, prices, "openai")
    assert cost is None and unknown == ["dims:gpt-6-astra:cached_input"]
    assert cost_usd({}, PRICES, "anthropic") == (None, ["no-usage"])
