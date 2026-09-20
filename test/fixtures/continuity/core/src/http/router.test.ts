import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./handler.ts";
import type { LogLine } from "../platform/logging/AppLogger.ts";

test("a routed request logs under the request id the handler layer assigned", async () => {
  const lines: LogLine[] = [];
  const app = createApp(undefined, (l) => lines.push(l));
  const res = await app.handle({ method: "POST", path: "/reports", headers: { "x-request-id": "req-http-1" }, body: { kind: "daily" } });
  assert.equal(res.status, 202);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].requestId, "req-http-1");
  assert.equal(lines[0].message, "report queued");
});
