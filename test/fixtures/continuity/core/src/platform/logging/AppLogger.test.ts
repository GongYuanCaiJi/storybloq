import test from "node:test";
import assert from "node:assert/strict";
import { AppLogger, redact, redactMessage, type LogLine } from "./AppLogger.ts";

test("secrets are redacted before a line is written", () => {
  const lines: LogLine[] = [];
  const log = AppLogger.withRequestId("req-1", (l) => lines.push(l));
  log.info("login", { user: "ada", password: "hunter2", token: "sk-abcdefghijk", note: "plain" });
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].fields, { user: "ada", password: "[REDACTED]", token: "[REDACTED]", note: "plain" });
  assert.deepEqual(redact({ Authorization: "Bearer abc" }), { Authorization: "[REDACTED]" });
});

test("secret-shaped values are redacted under neutral keys, at any depth, and inside the message", () => {
  const lines: LogLine[] = [];
  const log = AppLogger.withRequestId("req-2", (l) => lines.push(l));
  log.error("upstream refused Bearer abc for job", {
    detail: "Bearer abc",
    value: "sk-abcdefghijk",
    payload: { user: "ada", password: "hunter2", nested: [{ apiKey: "x" }, "sk-abcdefghijk", "plain", "reason: upstream refused Bearer abc twice"] },
    embedded: "upstream refused Bearer abc",
    count: 3,
  });
  assert.equal(lines[0].message, "upstream refused [REDACTED] for job");
  assert.deepEqual(lines[0].fields, {
    detail: "[REDACTED]",
    value: "[REDACTED]",
    payload: { user: "ada", password: "[REDACTED]", nested: [{ apiKey: "[REDACTED]" }, "[REDACTED]", "plain", "reason: upstream refused [REDACTED] twice"] },
    embedded: "upstream refused [REDACTED]",
    count: 3,
  });
  assert.equal(redactMessage("no secrets here"), "no secrets here");
});

test("every emitted line carries the request id", () => {
  const lines: LogLine[] = [];
  const log = AppLogger.withRequestId("req-42", (l) => lines.push(l));
  log.info("a");
  log.warn("b", { n: 1 });
  log.error("c");
  assert.equal(lines.length, 3);
  for (const line of lines) assert.equal(line.requestId, "req-42");
  assert.throws(() => AppLogger.withRequestId("  "), /non-empty request id/);
});
