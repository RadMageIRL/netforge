import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { hostHeadersFor } from '../unit/helpers/host-headers';

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

/**
 * Serves a private copy of dist/, so a test can "deploy" a new version without touching dist/.
 * With `base` (such as '/netforge/') the app lives under that path, as it would behind a proxy on
 * a shared site; the site root answers with a stand-in page for the rest of the site.
 * With `hostHeaders` every response, a 404 included, carries the headers the production host is
 * configured to send (vercel.json), so the browser enforces what it will enforce in production.
 * `deploy` rewrites a file of the copy, or creates it. `requests` lists every path asked for.
 */
export async function serveDistCopy(options: { base?: string; hostHeaders?: boolean } = {}): Promise<{ url: string; requests: string[]; deploy(file: string, edit: (text: string) => string): void; close(): Promise<void> }> {
  const base = options.base ?? '/';
  const root = mkdtempSync(join(tmpdir(), 'netforge-dist-'));
  cpSync(join(import.meta.dirname, '..', '..', 'dist'), root, { recursive: true });
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
    requests.push(pathname);
    if (!pathname.startsWith(base)) {
      res.writeHead(pathname === '/' ? 200 : 404, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Other app</title><p>Another app on the same site</p>');
      return;
    }
    const path = normalize(pathname.slice(base.length)).replace(/^[/\\]+/, '');
    const file = join(root, path === '' || path === '.' ? 'index.html' : path);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    const host = options.hostHeaders ? hostHeadersFor(pathname) : {};
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ...host }).end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...host }).end('Not found');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}${base}`,
    // Every path asked for, in order.
    requests,
    deploy: (file, edit) => writeFileSync(join(root, file), edit(existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '')),
    // A browser can hold a connection open; close them all so shutting down never waits on one.
    close: () => new Promise<void>(resolve => {
      server.close(() => { rmSync(root, { recursive: true, force: true }); resolve(); });
      server.closeAllConnections();
    }),
  };
}
