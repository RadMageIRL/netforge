/**
 * The worker side of a task: receive { id, request }, reply { id, result }. A handler that throws
 * is reported as a failed result instead of leaving the page waiting.
 */

export type Served<R> = { readonly ok: true; readonly value: R } | { readonly ok: false; readonly message: string };

interface WorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

export function serve<Q, R>(handler: (request: Q) => R | Promise<R>): void {
  const scope = self as unknown as WorkerScope;
  scope.onmessage = event => {
    const { id, request } = event.data as { id: number; request: Q };
    const reply = (result: Served<R>) => scope.postMessage({ id, result });
    try {
      Promise.resolve(handler(request)).then(
        value => reply({ ok: true, value }),
        error => reply({ ok: false, message: error instanceof Error ? error.message : String(error) }),
      );
    } catch (error) {
      reply({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  };
}
