/**
 * Request routing: maps a method and path to a handler. Each route receives
 * the request id the handler layer assigned, so anything a route logs goes
 * through AppLogger under that id.
 */
import { AppLogger, type Sink } from "../platform/logging/AppLogger.ts";

export interface RouteRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly requestId: string;
  readonly body?: unknown;
}

export interface RouteResponse {
  readonly status: number;
  readonly body: unknown;
}

export type RouteHandler = (req: RouteRequest, log: AppLogger) => RouteResponse | Promise<RouteResponse>;

export class Router {
  readonly #routes = new Map<string, RouteHandler>();
  readonly #sink: Sink | undefined;

  /** A sink can be supplied so a test can observe what routes log; production uses AppLogger's default. */
  constructor(sink?: Sink) {
    this.#sink = sink;
  }

  add(method: RouteRequest["method"], path: string, handler: RouteHandler): this {
    this.#routes.set(`${method} ${path}`, handler);
    return this;
  }

  async dispatch(req: RouteRequest): Promise<RouteResponse> {
    const log = AppLogger.withRequestId(req.requestId, this.#sink);
    const handler = this.#routes.get(`${req.method} ${req.path}`);
    if (!handler) {
      log.warn("no route", { method: req.method, path: req.path });
      return { status: 404, body: { error: "not found" } };
    }
    return handler(req, log);
  }
}
