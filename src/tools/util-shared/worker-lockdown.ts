/**
 * Removes every way to open a network connection from a worker, before any other worker code is
 * evaluated. Each worker imports this module first.
 *
 * Why it exists: the page's Content-Security-Policy is a meta element, and a worker does not
 * inherit it. A worker takes its policy from the HTTP headers of its own script. Where the host
 * sends the policy as a header (and where NetForge's service worker serves the script, which adds
 * the header itself), the browser already blocks connections. This module is the layer that holds
 * when neither applies, such as the first visit on a host without headers. NetForge's workers
 * never use the network; after this they could not, and neither could the bundled YAML parser.
 *
 * It is not a sandbox: only a real policy stops a dynamic import of a remote module. It removes
 * the ordinary network interfaces so that nothing reaches them by accident or through a
 * dependency that was not written to attack this exact module.
 */
const NAMES = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'RTCPeerConnection', 'importScripts', 'BroadcastChannel', 'SharedWorker', 'Worker'] as const;

function refuse(): never {
  throw new TypeError('NetForge workers have no network access.');
}

export function lockDown(scope: object): string[] {
  const removed: string[] = [];
  for (const name of NAMES) {
    let found = false;
    // The interfaces live on the global object or somewhere up its prototype chain.
    for (let target: object | null = scope; target; target = Object.getPrototypeOf(target) as object | null) {
      if (!Object.hasOwn(target, name) || (target as Record<string, unknown>)[name] === refuse) continue;
      found = true;
      try { delete (target as Record<string, unknown>)[name]; } catch { /* not configurable: shadowed below */ }
    }
    try {
      Object.defineProperty(scope, name, { value: refuse, writable: false, configurable: false, enumerable: false });
    } catch { /* already locked */ }
    if (found) removed.push(name);
  }
  const nav = (scope as { navigator?: object }).navigator;
  if (nav && 'sendBeacon' in nav) {
    try { Object.defineProperty(nav, 'sendBeacon', { value: refuse, writable: false, configurable: false }); } catch { /* nothing to do */ }
  }
  return removed;
}

if (typeof self !== 'undefined' && typeof (self as { document?: unknown }).document === 'undefined') lockDown(self);
