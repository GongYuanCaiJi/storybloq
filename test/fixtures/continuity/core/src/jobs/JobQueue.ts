/**
 * Background jobs. A job records the request id of the request that enqueued
 * it. Running a job does not log anything yet.
 */
export interface Job {
  readonly kind: string;
  readonly payload: unknown;
}

export interface QueuedJob extends Job {
  readonly id: string;
  readonly requestId: string;
  readonly enqueuedAt: number;
}

export type JobRunner = (job: QueuedJob) => Promise<void> | void;

export class JobQueue {
  readonly #jobs: QueuedJob[] = [];
  #next = 1;

  enqueue(job: Job, opts: { requestId: string }): string {
    const id = `job-${this.#next++}`;
    this.#jobs.push({ ...job, id, requestId: opts.requestId, enqueuedAt: Date.now() });
    return id;
  }

  get size(): number {
    return this.#jobs.length;
  }

  /** Runs every queued job in order. A failing job is dropped; the rest still run. */
  async run(runner: JobRunner): Promise<{ ran: number; failed: number }> {
    let ran = 0;
    let failed = 0;
    while (this.#jobs.length > 0) {
      const job = this.#jobs.shift()!;
      try {
        await runner(job);
        ran++;
      } catch {
        failed++;
      }
    }
    return { ran, failed };
  }
}
