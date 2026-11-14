/**
 * The page side of a worker task: wraps a Web Worker for the TaskRunner, which enforces the time
 * limit by terminating the worker. Workers are created only when a tool first needs one.
 */
import { TaskRunner, type TaskOutcome, type WorkerLike } from '../../core/worker/task-runner';
import type { Served } from './worker-host';

function workerLike(worker: Worker): WorkerLike {
  const like: WorkerLike = {
    postMessage: message => worker.postMessage(message),
    terminate: () => worker.terminate(),
    onmessage: null,
    onerror: null,
  };
  worker.onmessage = event => like.onmessage?.({ data: event.data });
  worker.onerror = event => {
    event.preventDefault();
    like.onerror?.({ message: event.message || 'The worker stopped unexpectedly.' });
  };
  worker.onmessageerror = () => like.onerror?.({ message: 'The worker sent a result that could not be read.' });
  return like;
}

export type Outcome<R> = TaskOutcome<Served<R>>;

export function createRunner<Q, R>(create: () => Worker, timeoutMs: number): TaskRunner<Q, Served<R>> {
  return new TaskRunner<Q, Served<R>>(() => workerLike(create()), timeoutMs);
}

/** What to tell the user when a task did not produce a result. Null for a superseded task. */
export function failureText(outcome: Exclude<TaskOutcome<Served<unknown>>, { status: 'done' }>, what: string): string | null {
  if (outcome.status === 'superseded') return null;
  if (outcome.status === 'timeout') {
    return `Stopped after ${outcome.limitMs / 1000} seconds: ${what} was still running, so it was terminated. Nothing was frozen, and you can change the input and try again.`;
  }
  return `The background worker failed (${outcome.message}). It has been replaced; try again, with smaller input if this repeats.`;
}
