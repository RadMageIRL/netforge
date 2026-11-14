/**
 * Runs one task at a time on a worker thread under a real time limit. JavaScript cannot interrupt
 * code that is running, so the limit is enforced from outside: when the timer fires, the worker
 * is terminated, whatever it was doing, and a fresh one takes its place. Checking the clock after
 * the task returns would not help, because a runaway task never returns.
 *
 * The worker is supplied by the caller (a Web Worker in the app, a stand-in in tests), so the
 * policy here is plain logic with no browser dependency.
 */

export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type TaskOutcome<R> =
  | { readonly status: 'done'; readonly value: R; readonly elapsedMs: number }
  /** The time limit passed; the worker was terminated and replaced. */
  | { readonly status: 'timeout'; readonly limitMs: number }
  /** The worker failed (an uncaught error, or it ran out of memory); it was replaced. */
  | { readonly status: 'crashed'; readonly message: string }
  /** A newer task replaced this one before it finished; its worker was terminated. */
  | { readonly status: 'superseded' };

export interface Clock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const SYSTEM_CLOCK: Clock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

interface Pending<R> {
  readonly id: number;
  readonly resolve: (outcome: TaskOutcome<R>) => void;
  readonly timer: unknown;
  readonly startedAt: number;
}

export class TaskRunner<Q, R> {
  private worker: WorkerLike | null = null;
  private pending: Pending<R> | null = null;
  private nextId = 1;
  private disposed = false;
  /** How many workers have been created, and how many were terminated for exceeding the limit. */
  spawned = 0;
  timeouts = 0;

  constructor(
    private readonly spawn: () => WorkerLike,
    private readonly defaultTimeoutMs: number,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {
    if (!(defaultTimeoutMs > 0)) throw new RangeError('A task needs a positive time limit.');
  }

  /** True while a task is running. */
  get busy(): boolean {
    return this.pending !== null;
  }

  /**
   * Runs `request` on the worker. If a task is already running, it is stopped first (its worker
   * is terminated and its promise resolves as superseded). The promise always resolves.
   */
  run(request: Q, timeoutMs = this.defaultTimeoutMs): Promise<TaskOutcome<R>> {
    if (this.disposed) return Promise.resolve({ status: 'crashed', message: 'The task runner has been shut down.' });
    if (!(timeoutMs > 0)) throw new RangeError('A task needs a positive time limit.');
    if (this.pending) this.stop({ status: 'superseded' });
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<TaskOutcome<R>>(resolve => {
      const timer = this.clock.setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.timeouts++;
        this.stop({ status: 'timeout', limitMs: timeoutMs });
        // Have a replacement ready before the next task arrives.
        if (!this.disposed) this.ensureWorker();
      }, timeoutMs);
      this.pending = { id, resolve, timer, startedAt: this.clock.now() };
      try {
        worker.postMessage({ id, request });
      } catch (error) {
        this.stop({ status: 'crashed', message: `The task could not be sent to the worker: ${(error as Error).message}` });
      }
    });
  }

  /** Stops any running task and releases the worker. */
  dispose(): void {
    this.disposed = true;
    if (this.pending) this.stop({ status: 'superseded' });
    this.release();
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    this.spawned++;
    worker.onmessage = event => {
      // A terminated worker can still have a message in flight; only the current one counts.
      if (worker !== this.worker) return;
      const data = event.data as { id?: unknown; result?: unknown } | null;
      const pending = this.pending;
      if (!pending || !data || data.id !== pending.id) return;
      this.clock.clearTimeout(pending.timer);
      this.pending = null;
      pending.resolve({ status: 'done', value: data.result as R, elapsedMs: this.clock.now() - pending.startedAt });
    };
    worker.onerror = event => {
      if (worker !== this.worker) return;
      const message = typeof (event as { message?: unknown } | null)?.message === 'string' ? (event as { message: string }).message : 'The worker stopped unexpectedly.';
      if (this.pending) this.stop({ status: 'crashed', message });
      else this.release();
    };
    this.worker = worker;
    return worker;
  }

  /** Ends the running task with `outcome` and terminates its worker: the only way to stop it. */
  private stop(outcome: TaskOutcome<R>): void {
    const pending = this.pending;
    this.pending = null;
    this.release();
    if (pending) {
      this.clock.clearTimeout(pending.timer);
      pending.resolve(outcome);
    }
  }

  private release(): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
  }
}
