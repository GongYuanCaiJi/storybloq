# Rules

1. Every emitted log line carries the request id of the work it belongs to, and secrets never reach a log line unredacted.
2. Keep the code dependency-free: Node built-ins only.
3. A change to behaviour comes with a test under the same directory, named `<Module>.test.ts`.
