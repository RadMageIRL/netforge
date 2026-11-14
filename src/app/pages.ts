/** The shell's own pages: home, about and privacy, planned tools and not found. */
import { emptyState, notice, pageHeader, panel } from '../ui/components';
import { h, replaceChildren } from '../ui/dom';
import { icon } from '../ui/icons';
import type { Prefs } from './prefs';
import type { ToolMeta, ToolRegistry } from './registry';
import { formatRoute } from './router';

export const VERSION_LABEL = `v${__APP_VERSION__}`;

const PRIVACY_POINTS = [
  'Every tool runs in your browser. Addresses, subnet plans, JSON, timestamps and anything else you enter are processed on this device and never sent to a server.',
  'A Content-Security-Policy blocks the page from opening network connections (fetch, XHR, WebSocket or beacons) and from loading anything from another site.',
  'No analytics, no tracking, no cookies and no third-party scripts, fonts or other resources. Everything NetForge needs ships with it.',
  'Tool input stays in memory and is gone when you close or reload the page. Only the display preferences listed below are saved on this device.',
];

const SHORTCUTS: readonly [string, string][] = [
  ['/', 'Search tools (when not typing in a field)'],
  ['Ctrl+K or Cmd+K', 'Search tools from anywhere'],
  ['Enter in search', 'Open the best match'],
  ['Arrow keys in the tool list', 'Move between tools'],
  ['Escape', 'Clear the search, or close the menu on small screens'],
];

function shortcutTable(): HTMLTableElement {
  return h('table', { class: 'plain-table' },
    h('caption', { class: 'visually-hidden' }, 'Keyboard shortcuts'),
    h('tbody', null, SHORTCUTS.map(([keys, what]) => h('tr', null, h('th', { scope: 'row' }, h('kbd', null, keys)), h('td', null, what)))),
  );
}

export function homePage(registry: ToolRegistry): HTMLElement {
  const available = registry.list().filter(t => t.status === 'available');
  const planned = registry.list().filter(t => t.status === 'planned');
  return h('div', { class: 'page home-page' },
    pageHeader('RadMage Labs', 'NetForge', 'Local-first IT and network engineering toolbox. Every tool runs in your browser: nothing you paste or type leaves this device.'),
    h('section', { class: 'home-section', 'aria-labelledby': 'home-tools' },
      h('h2', { id: 'home-tools', class: 'section-title' }, 'Tools'),
      h('ul', { class: 'card-grid' }, available.map(tool => h('li', null,
        h('a', { class: 'tool-card', href: formatRoute({ name: 'tool', id: tool.id }) },
          h('span', { class: 'tool-card-category' }, registry.categoryName(tool.category)),
          h('span', { class: 'tool-card-name' }, tool.name),
          h('span', { class: 'tool-card-summary' }, tool.summary),
        ),
      ))),
    ),
    h('section', { class: 'home-section', 'aria-labelledby': 'home-planned' },
      h('h2', { id: 'home-planned', class: 'section-title' }, 'Planned'),
      h('p', { class: 'muted' }, 'These tools are planned and not built yet.'),
      h('div', { class: 'planned-grid' }, registry.listCategories().map(category => {
        const tools = planned.filter(t => t.category === category.id);
        if (tools.length === 0) return null;
        return h('div', { class: 'planned-group' },
          h('h3', { class: 'planned-heading' }, category.name),
          h('ul', { class: 'planned-list' }, tools.map(t => h('li', null, h('a', { href: formatRoute({ name: 'tool', id: t.id }) }, t.name)))),
        );
      })),
    ),
    h('section', { class: 'home-section', 'aria-labelledby': 'home-keys' },
      h('h2', { id: 'home-keys', class: 'section-title' }, 'Keyboard'),
      shortcutTable(),
    ),
  );
}

export function aboutPage(prefs: Prefs, clearPrefs: () => void): HTMLElement {
  const storedBody = h('div');
  const renderStored = () => {
    const stored = prefs.stored();
    replaceChildren(storedBody,
      stored.length === 0
        ? emptyState('Nothing is stored on this device.')
        : h('table', { class: 'plain-table', id: 'stored-prefs' },
            h('caption', { class: 'visually-hidden' }, 'Preferences stored on this device'),
            h('tbody', null, stored.map(s => h('tr', null, h('th', { scope: 'row' }, s.label), h('td', { class: 'mono' }, s.value)))),
          ),
      h('div', { class: 'toolbar' },
        h('button', {
          type: 'button', class: 'btn btn-secondary', id: 'clear-prefs', disabled: stored.length === 0,
          onclick: () => { clearPrefs(); renderStored(); },
        }, 'Clear preferences'),
      ),
    );
  };
  renderStored();

  const offline = 'serviceWorker' in navigator && navigator.serviceWorker.controller
    ? notice('ok', 'This version of NetForge is saved in your browser and works without an internet connection.')
    : notice('info', 'NetForge saves itself for offline use the first time it is opened over HTTPS or from localhost. This copy is not saved yet.');

  return h('div', { class: 'page about-page' },
    pageHeader(`NetForge ${VERSION_LABEL}`, 'About NetForge', 'A collection of practical tools for systems administrators, network engineers and developers, published by RadMage Labs.'),
    panel('Privacy', [h('ul', { class: 'privacy-list' }, PRIVACY_POINTS.map(p => h('li', null, icon('shield'), h('span', null, p))))]),
    panel('Stored on this device', [
      h('p', { class: 'muted' }, 'NetForge saves only these display preferences, in this browser\'s local storage. Clearing them restores the defaults.'),
      storedBody,
    ]),
    panel('Offline use', [offline]),
    panel('Keyboard shortcuts', [shortcutTable()]),
    panel('Version', [h('p', null, `NetForge ${VERSION_LABEL}. In development; not released.`)]),
  );
}

export function plannedPage(tool: ToolMeta, categoryName: string): HTMLElement {
  return h('div', { class: 'page planned-page' },
    pageHeader(categoryName, tool.name, tool.summary),
    notice('info', h('strong', null, 'Planned. '), 'This tool is not built yet.'),
    h('p', null, h('a', { href: formatRoute({ name: 'home' }) }, 'See the tools that are available now')),
  );
}

export function notFoundPage(id: string): HTMLElement {
  return h('div', { class: 'page' },
    pageHeader('NetForge', 'Page not found', `There is no tool called "${id}".`),
    h('p', null, h('a', { href: formatRoute({ name: 'home' }) }, 'Browse all tools')),
  );
}
