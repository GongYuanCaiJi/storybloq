/**
 * HTTP entry: assigns a request id to every incoming request and hands it to
 * the router. This is where the request id is born.
 */
import { randomUUID } from "node:crypto";
import { Router, type RouteRequest, type RouteResponse } from "./router.ts";
import { JobQueue } from "../jobs/JobQueue.ts";
import type { Sink } from "../platform/logging/AppLogger.ts";

export interface IncomingRequest {
  readonly method: RouteRequest["method"];
  readonly path: string;
  readonly headers: Record<string, string | undefined>;
  readonly body?: unknown;
}

export function createApp(queue: JobQueue = new JobQueue(), sink?: Sink): { handle(req: IncomingRequest): Promise<RouteResponse> } {
  const router = new Router(sink)
    .add("GET", "/health", (_req, log) => {
      log.info("health check");
      return { status: 200, body: { ok: true } };
    })
    .add("POST", "/reports", (req, log) => {
      const id = queue.enqueue({ kind: "report", payload: req.body }, { requestId: req.requestId });
      log.info("report queued", { jobId: id });
      return { status: 202, body: { jobId: id } };
    });

  return {
    async handle(req: IncomingRequest): Promise<RouteResponse> {
      const requestId = req.headers["x-request-id"] ?? randomUUID();
      return router.dispatch({ method: req.method, path: req.path, requestId, body: req.body });
    },
  };
}
