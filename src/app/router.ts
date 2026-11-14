/**
 * Hash routes (#/subnet-calculator). Hash routing needs no server rewrites, so the same build works
 * on GitHub Pages, behind a proxy under /netforge/, and from a local preview.
 */

export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'about' }
  | { readonly name: 'tool'; readonly id: string };

export function parseRoute(hash: string): Route {
  let path = hash.startsWith('#') ? hash.slice(1) : hash;
  if (path.startsWith('/')) path = path.slice(1);
  path = path.split('?')[0].replace(/\/+$/, '');
  if (path === '' || path === 'home') return { name: 'home' };
  if (path === 'about') return { name: 'about' };
  let id: string;
  try {
    id = decodeURIComponent(path).toLowerCase();
  } catch {
    id = path.toLowerCase();
  }
  return { name: 'tool', id };
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case 'home': return '#/';
    case 'about': return '#/about';
    case 'tool': return `#/${encodeURIComponent(route.id)}`;
  }
}
