/**
 * The task runner's time limit. First with a stand-in worker and clock, to pin every rule; then
 * with a real thread running a genuinely catastrophic regular expression, to prove the limit is an
 * actual termination and not a look at the clock after the task returns (it never returns).
 */
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskRunner, type Clock, type TaskOutcome, type WorkerLike } from '../../src/core/worker/task-runner';

class FakeWorker implements WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly posted: { id: number; request: unknown }[] = [];
  terminated = false;
  throwOnPost: Error | null = null;
  /** Handlers captured at spawn time, to simulate messages that were already in flight. */
  private captured: { message: ((event: { data: unknown }) => void) | null; error: ((event: unknown) => void) | null } | null = null;

  postMessage(message: unknown): void {
    if (this.throwOnPost) throw this.throwOnPost;
    this.captured = { message: this.onmessage, error: this.onerror };
    this.posted.push(message as { id: number; request: unknown });
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(result: unknown, id = this.posted[this.posted.length - 1].id): void {
    this.onmessage?.({ data: { id, result } });
  }

  /** Delivers a message through the handler that was installed when the task was posted. */
  lateReply(result: unknown, id = this.posted[this.posted.length - 1].id): void {
    this.captured?.message?.({ data: { id, result } });
  }

  lateError(message: string): void {
    this.captured?.error?.({ message });
  }
}

class FakeClock implements Clock {
  time = 1000;
  private next = 1;
  readonly timers = new Map<number, { at: number; handler: () => void }>();

  setTimeout(handler: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, handler });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.time) {
        this.timers.delete(id);
        timer.handler();
      }
    }
  }
}

function setup(timeoutMs = 2000) {
  const workers: FakeWorker[] = [];
  const clock = new FakeClock();
  const runner = new TaskRunner<string, string>(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  }, timeoutMs, clock);
  return { workers, clock, runner };
}

describe('task runner rules (stand-in worker and clock)', () => {
  it('resolves with the result and the elapsed time', async () => {
    const { workers, clock, runner } = setup();
    expect(runner.spawned).toBe(0);
    const pending = runner.run('job');
    expect(runner.busy).toBe(true);
    expect(workers).toHaveLength(1);
    expect(workers[0].posted).toEqual([{ id: 1, request: 'job' }]);
    clock.advance(250);
    workers[0].reply('answer');
    expect(await pending).toEqual({ status: 'done', value: 'answer', elapsedMs: 250 });
    expect(runner.busy).toBe(false);
    expect(workers[0].terminated).toBe(false);
    // The timer was cancelled: time passing later does nothing.
    expect(clock.timers.size).toBe(0);
    clock.advance(10_000);
    expect(workers[0].terminated).toBe(false);
    expect(runner.timeouts).toBe(0);
  });

  it('reuses an idle worker for the next task', async () => {
    const { workers, runner } = setup();
    const first = runner.run('one');
    workers[0].reply('1');
    await first;
    const second = runner.run('two');
    expect(workers).toHaveLength(1);
    expect(workers[0].posted.map(p => p.id)).toEqual([1, 2]);
    workers[0].reply('2');
    expect(await second).toMatchObject({ status: 'done', value: '2' });
    expect(runner.spawned).toBe(1);
  });

  it('terminates the worker when the limit passes, and has a replacement ready', async () => {
    const { workers, clock, runner } = setup(2000);
    const pending = runner.run('runaway');
    clock.advance(1999);
    expect(workers[0].terminated).toBe(false);
    expect(runner.busy).toBe(true);
    clock.advance(1);
    expect(await pending).toEqual({ status: 'timeout', limitMs: 2000 });
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].onmessage).toBeNull();
    expect(runner.timeouts).toBe(1);
    expect(runner.busy).toBe(false);
    // Replaced before any new task is asked for.
    expect(workers).toHaveLength(2);
    expect(runner.spawned).toBe(2);
    expect(workers[1].terminated).toBe(false);

    const next = runner.run('normal');
    expect(workers).toHaveLength(2);
    expect(workers[1].posted).toEqual([{ id: 2, request: 'normal' }]);
    workers[1].reply('fine');
    expect(await next).toMatchObject({ status: 'done', value: 'fine' });
  });

  it('uses the per-task limit when one is given', async () => {
    const { workers, clock, runner } = setup(2000);
    const pending = runner.run('job', 100);
    clock.advance(100);
    expect(await pending).toEqual({ status: 'timeout', limitMs: 100 });
    expect(workers[0].terminated).toBe(true);
  });

  it('ignores a message that arrives from a terminated worker', async () => {
    const { workers, clock, runner } = setup(500);
    const first = runner.run('slow');
    clock.advance(500);
    expect(await first).toMatchObject({ status: 'timeout' });
    const second = runner.run('next');
    let settled: TaskOutcome<string> | null = null;
    void second.then(o => { settled = o; });
    // The old worker's answer was already on its way. It must not be taken for the new task's,
    // even if it carries the new task's id.
    workers[0].lateReply('stale', 2);
    workers[0].lateError('stale failure');
    await Promise.resolve();
    expect(settled).toBeNull();
    expect(runner.busy).toBe(true);
    expect(workers[1].terminated).toBe(false);
    workers[1].reply('fresh');
    expect(await second).toMatchObject({ status: 'done', value: 'fresh' });
  });

  it('ignores a message with the wrong id, or no id', async () => {
    const { workers, runner } = setup();
    const pending = runner.run('job');
    let settled: TaskOutcome<string> | null = null;
    void pending.then(o => { settled = o; });
    workers[0].reply('wrong', 99);
    workers[0].onmessage?.({ data: null });
    workers[0].onmessage?.({ data: { result: 'no id' } });
    await Promise.resolve();
    expect(settled).toBeNull();
    workers[0].reply('right');
    expect(await pending).toMatchObject({ status: 'done', value: 'right' });
  });

  it('ignores a message when no task is running', async () => {
    const { workers, runner } = setup();
    const first = runner.run('job');
    workers[0].reply('a');
    await first;
    workers[0].reply('again', 1);
    expect(runner.busy).toBe(false);
    const second = runner.run('job2');
    workers[0].reply('b');
    expect(await second).toMatchObject({ value: 'b' });
  });

  it('a new task supersedes the running one by terminating its worker', async () => {
    const { workers, clock, runner } = setup();
    const first = runner.run('old');
    const second = runner.run('new');
    // Already settled by the time run() returns: the race never has to wait.
    expect(await Promise.race([first, Promise.resolve('still running')])).toEqual({ status: 'superseded' });
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].posted).toEqual([{ id: 2, request: 'new' }]);
    // The first task's timer is gone: only the second can time out.
    expect(clock.timers.size).toBe(1);
    expect(runner.timeouts).toBe(0);
    workers[1].reply('result');
    expect(await second).toMatchObject({ status: 'done', value: 'result' });
    expect(runner.spawned).toBe(2);
  });

  it('reports a crashed worker and replaces it', async () => {
    const { workers, clock, runner } = setup();
    const pending = runner.run('job');
    workers[0].onerror?.({ message: 'out of memory' });
    expect(await pending).toEqual({ status: 'crashed', message: 'out of memory' });
    expect(workers[0].terminated).toBe(true);
    expect(clock.timers.size).toBe(0);
    const next = runner.run('again');
    expect(workers).toHaveLength(2);
    workers[1].reply('ok');
    expect(await next).toMatchObject({ status: 'done' });

    // An error with no message still resolves.
    const third = runner.run('x');
    workers[1].onerror?.(null);
    expect(await third).toEqual({ status: 'crashed', message: 'The worker stopped unexpectedly.' });
  });

  it('drops an idle worker that reports an error', async () => {
    const { workers, runner } = setup();
    const first = runner.run('job');
    workers[0].reply('a');
    await first;
    workers[0].onerror?.({ message: 'late failure' });
    expect(workers[0].terminated).toBe(true);
    const second = runner.run('job2');
    expect(workers).toHaveLength(2);
    workers[1].reply('b');
    expect(await second).toMatchObject({ value: 'b' });
  });

  it('reports a task that cannot be sent', async () => {
    const workers: FakeWorker[] = [];
    const clock = new FakeClock();
    const runner = new TaskRunner<string, string>(() => {
      const w = new FakeWorker();
      w.throwOnPost = new Error('could not be cloned');
      workers.push(w);
      return w;
    }, 1000, clock);
    const outcome = await runner.run('job');
    expect(outcome.status).toBe('crashed');
    expect(outcome.status === 'crashed' && outcome.message).toContain('could not be cloned');
    expect(workers[0].terminated).toBe(true);
    expect(clock.timers.size).toBe(0);
    expect(runner.busy).toBe(false);
  });

  it('dispose stops the running task and refuses new ones', async () => {
    const { workers, clock, runner } = setup();
    const pending = runner.run('job');
    runner.dispose();
    expect(await pending).toEqual({ status: 'superseded' });
    expect(workers[0].terminated).toBe(true);
    expect(clock.timers.size).toBe(0);
    const late = runner.run('more');
    expect(workers).toHaveLength(1);
    expect(await Promise.race([late, Promise.resolve('still running')])).toMatchObject({ status: 'crashed' });
  });

  it('dispose releases an idle worker, and a timeout after dispose spawns nothing', async () => {
    const { workers, runner } = setup();
    const first = runner.run('job');
    workers[0].reply('a');
    await first;
    runner.dispose();
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(1);
  });

  it('requires a positive time limit', () => {
    const spawn = () => new FakeWorker();
    expect(() => new TaskRunner(spawn, 0)).toThrow(RangeError);
    expect(() => new TaskRunner(spawn, -5)).toThrow(RangeError);
    expect(() => new TaskRunner(spawn, Number.NaN)).toThrow(RangeError);
    const { runner } = setup();
    expect(() => runner.run('job', 0)).toThrow(RangeError);
    expect(() => runner.run('job', Number.NaN)).toThrow(RangeError);
    expect(runner.busy).toBe(false);
  });
});

// A real thread ---------------------------------------------------------------------------------

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, request }) => {
  const re = new RegExp(request.pattern);
  parentPort.postMessage({ id, result: re.test(request.text) });
});
`;

interface RealRequest { pattern: string; text: string }

function realSetup(timeoutMs: number) {
  const threads: { worker: Worker; exited: Promise<number>; hasExited: boolean }[] = [];
  const runner = new TaskRunner<RealRequest, boolean>(() => {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    const record = { worker, hasExited: false, exited: new Promise<number>(resolve => worker.once('exit', code => { record.hasExited = true; resolve(code); })) };
    threads.push(record);
    const like: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: message => worker.postMessage(message),
      terminate: () => { void worker.terminate(); },
    };
    worker.on('message', data => like.onmessage?.({ data }));
    worker.on('error', error => like.onerror?.(error));
    return like;
  }, timeoutMs);
  return { threads, runner };
}

describe('task runner with a real thread and a catastrophic pattern', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it('stops (a+)+$ at the limit by terminating the thread, then carries on with a new one', async () => {
    const { threads, runner } = realSetup(300);
    cleanup = async () => { runner.dispose(); await Promise.all(threads.map(t => t.exited)); };

    // A quick task first: the thread works and the limit does not fire early.
    const quick = await runner.run({ pattern: '^a+$', text: 'aaaa' });
    expect(quick).toMatchObject({ status: 'done', value: true });
    expect(threads).toHaveLength(1);

    // Exponential backtracking: 2^40 paths. Left alone, this runs for longer than anyone will wait.
    const started = Date.now();
    const outcome = await runner.run({ pattern: '(a+)+$', text: `${'a'.repeat(40)}!` });
    const elapsed = Date.now() - started;
    expect(outcome).toEqual({ status: 'timeout', limitMs: 300 });
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(3000);
    expect(runner.timeouts).toBe(1);

    // The thread that was running the pattern is really gone, mid-match.
    const exitCode = await threads[0].exited;
    expect(threads[0].hasExited).toBe(true);
    expect(exitCode).toBe(1);

    // A replacement was created, and ordinary work continues on it.
    expect(threads).toHaveLength(2);
    expect(threads[1].hasExited).toBe(false);
    const after = await runner.run({ pattern: 'b', text: 'abc' });
    expect(after).toMatchObject({ status: 'done', value: true });
    expect(runner.spawned).toBe(2);

    // Nothing is left running once the runner is disposed.
    runner.dispose();
    await threads[1].exited;
    expect(threads.every(t => t.hasExited)).toBe(true);
  });

  it('a newer task stops a runaway one without waiting for the limit', async () => {
    const { threads, runner } = realSetup(5000);
    cleanup = async () => { runner.dispose(); await Promise.all(threads.map(t => t.exited)); };
    const started = Date.now();
    const runaway = runner.run({ pattern: '(a+)+$', text: `${'a'.repeat(40)}!` });
    await new Promise(resolve => setTimeout(resolve, 50));
    const next = runner.run({ pattern: 'a', text: 'a' });
    expect(await runaway).toEqual({ status: 'superseded' });
    expect(await next).toMatchObject({ status: 'done', value: true });
    await threads[0].exited;
    expect(Date.now() - started).toBeLessThan(4000);
    expect(runner.timeouts).toBe(0);
  });

  it('reports a thread that throws as crashed', async () => {
    const { threads, runner } = realSetup(5000);
    cleanup = async () => { runner.dispose(); await Promise.all(threads.map(t => t.exited)); };
    const outcome = await runner.run({ pattern: '(', text: '' });
    expect(outcome.status).toBe('crashed');
    const next = await runner.run({ pattern: 'a', text: 'a' });
    expect(next).toMatchObject({ status: 'done', value: true });
    expect(threads).toHaveLength(2);
  });
});
