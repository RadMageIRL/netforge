/**
 * Offline support. A service worker precaches the whole app on the first visit and serves it from
 * the cache afterward. A new version downloads in the background and takes over only when the user
 * chooses Reload, so a page in use is never swapped out underneath them.
 */
import { byId } from '../ui/dom';

export function setupOffline(): void {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD || location.protocol === 'file:') return;
  window.addEventListener('load', async () => {
    let registration: ServiceWorkerRegistration | undefined;
    try {
      registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    } catch {
      return;
    }
    // Some embedded and automated browsers stub register() and resolve without a registration.
    if (!registration) return;
    const offer = (worker: ServiceWorker | null) => { if (worker && navigator.serviceWorker.controller) showUpdate(worker); };
    offer(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const incoming = registration.installing;
      incoming?.addEventListener('statechange', () => { if (incoming.state === 'installed') offer(incoming); });
    });
    // Long-lived sessions still learn about updates: hourly, and whenever the page is looked at again.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') registration.update().catch(() => undefined); });
    window.setInterval(() => { registration.update().catch(() => undefined); }, 60 * 60 * 1000);
  });
}

function showUpdate(worker: ServiceWorker): void {
  const bar = byId('update-bar');
  bar.hidden = false;
  byId('update-later').onclick = () => { bar.hidden = true; };
  byId('update-reload').onclick = () => {
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloaded) {
        reloaded = true;
        location.reload();
      }
    });
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
}
