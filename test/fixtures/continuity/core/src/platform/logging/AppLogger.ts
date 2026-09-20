/**
 * AppLogger: the one logger this service uses.
 *
 * Two guarantees, both covered by AppLogger.test.ts:
 * - every line carries the request id it belongs to (`withRequestId`), and
 * - values that look like secrets are redacted before they are written: by key or by shape, at any depth of
 *   the fields, and secret-shaped tokens inside the message text.
 */
export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  readonly level: LogLevel;
  readonly requestId: string;
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

const SECRET_KEY = /(token|secret|password|authorization|apikey|api_key)/i;
const SECRET_VALUE = /^(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)$/;
const SECRET_IN_TEXT = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/g;

/**
 * Replaces secret-looking values with "[REDACTED]" at every depth: a key that names a secret, a string value
 * shaped like one, inside nested objects and arrays alike. Other values pass through unchanged.
 */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue(fields) as Record<string, unknown>;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(v);
    }
    return out;
  }
  if (typeof value === "string") return SECRET_VALUE.test(value) ? "[REDACTED]" : redactMessage(value);
  return value;
}

/** Free text: every secret-shaped token inside it is replaced, the rest is kept. Applied to messages and to every string field. */
export function redactMessage(message: string): string {
  return message.replace(SECRET_IN_TEXT, "[REDACTED]");
}

export type Sink = (line: LogLine) => void;

export class AppLogger {
  readonly #requestId: string;
  readonly #sink: Sink;

  private constructor(requestId: string, sink: Sink) {
    this.#requestId = requestId;
    this.#sink = sink;
  }

  /** A logger bound to one request id. Every line it emits carries that id. */
  static withRequestId(requestId: string, sink: Sink = defaultSink): AppLogger {
    if (requestId.trim() === "") throw new Error("AppLogger requires a non-empty request id");
    return new AppLogger(requestId, sink);
  }

  get requestId(): string {
    return this.#requestId;
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.#emit("info", message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.#emit("warn", message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.#emit("error", message, fields);
  }

  #emit(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    this.#sink({ level, requestId: this.#requestId, message: redactMessage(message), fields: redact(fields) });
  }
}

function defaultSink(line: LogLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
