/**
 * The application shell: navigation, search, routing, theme and the mobile drawer. Tools render
 * into their own view, created on first visit and kept in memory while the page is open, so
 * switching tools does not lose work. Nothing a tool holds is written to storage.
 */
import { copyText } from '../ui/clipboard';
import { downloadText } from '../ui/download';
import { byId, h, isEditable, replaceChildren } from '../ui/dom';
import { announce, toast } from '../ui/feedback';
import { icon } from '../ui/icons';
import { aboutPage, homePage, labsLink, notFoundPage, plannedPage } from './pages';
import type { Prefs } from './prefs';
import { type AvailableTool, type ToolInstance, type ToolMeta, type ToolRegistry, type ToolServices } from './registry';
import { formatRoute, parseRoute, type Route } from './router';
import { searchTools, type SearchableTool } from './search';
import { readShareQuery, REFUSED_TEXT, toolLink } from './share';
import { createShareDialog } from './share-dialog';

const MOBILE_QUERY = '(max-width: 899px)';
const APP_TITLE = 'NetForge';

interface MountedTool {
  readonly root: HTMLElement;
  instance: ToolInstance | void;
}

export function startShell(registry: ToolRegistry, prefs: Prefs): void {
  const view = byId('view');
  const main = byId('main');
  const nav = byId('tool-nav');
  const search = byId<HTMLInputElement>('tool-search');
  const searchStatus = byId('search-status');
  const navToggle = byId<HTMLButtonElement>('nav-toggle');
  const scrim = byId('scrim');
  const themeToggle = byId<HTMLButtonElement>('theme-toggle');
  const mobile = window.matchMedia(MOBILE_QUERY);

  const services: ToolServices = {
    prefs,
    announce,
    async copy(text, what) {
      try {
        await copyText(text);
        toast(`Copied ${what}`);
        announce(`Copied ${what} to the clipboard.`);
        return true;
      } catch {
        toast('Copy failed: the browser blocked clipboard access', 'error');
        announce('Copy failed. The browser blocked clipboard access.');
        return false;
      }
    },
    download(filename, text, mime) {
      const saved = downloadText(filename, text, mime);
      toast(`Downloaded ${saved}`);
      announce(`Downloaded ${saved}.`);
    },
  };

  const entries: SearchableTool[] = registry.list().map(tool => ({ tool, categoryName: registry.categoryName(tool.category) }));
  const mounted = new Map<string, MountedTool>();
  let pageNode: HTMLElement | null = null;
  let renderToken = 0;
  let currentToolId: string | null = null;

  // ---- Navigation -------------------------------------------------------------------------
  const links = new Map<string, HTMLAnchorElement>();
  const homeLink = h('a', { href: formatRoute({ name: 'home' }), class: 'nav-link nav-home', 'data-route': 'home' }, h('span', null, 'All tools'));
  const noMatches = h('p', { class: 'nav-empty', hidden: true });
  const groups = registry.listCategories().map(category => {
    const headingId = `nav-${category.id}`;
    const items = registry.inCategory(category.id).map(tool => {
      const link = h('a', { href: formatRoute({ name: 'tool', id: tool.id }), class: `nav-link${tool.status === 'planned' ? ' planned' : ''}`, 'data-tool': tool.id },
        h('span', { class: 'nav-name' }, tool.name),
        tool.status === 'planned' ? h('span', { class: 'tag' }, 'Planned') : null,
      );
      links.set(tool.id, link);
      return { tool, item: h('li', null, link) };
    });
    const group = h('div', { class: 'nav-group' },
      h('h2', { class: 'nav-heading', id: headingId }, category.name),
      h('ul', { class: 'nav-list', 'aria-labelledby': headingId }, items.map(i => i.item)),
    );
    return { group, items };
  });
  replaceChildren(nav, h('ul', { class: 'nav-list nav-top' }, h('li', null, homeLink)), groups.map(g => g.group), noMatches);
  // Back to the RadMage Labs homepage, in a new tab so nothing open here is lost.
  byId('sidebar').appendChild(h('div', { class: 'sidebar-foot' }, labsLink('labs-link nav-labs', 'sidebar-labs-link')));

  const shareDialog = createShareDialog(announce);
  document.body.appendChild(shareDialog.element);

  function visibleLinks(): HTMLAnchorElement[] {
    return [homeLink, ...links.values()].filter(link => link.closest('[hidden]') === null);
  }

  // ---- Search -----------------------------------------------------------------------------
  let lastResults: ToolMeta[] = registry.list().slice();

  function applySearch(): void {
    const query = search.value;
    lastResults = searchTools(entries, query);
    const shown = new Set(lastResults.map(t => t.id));
    const filtering = query.trim() !== '';
    homeLink.parentElement!.hidden = filtering;
    for (const g of groups) {
      let any = false;
      for (const { tool, item } of g.items) {
        item.hidden = !shown.has(tool.id);
        any ||= !item.hidden;
      }
      g.group.hidden = !any;
    }
    noMatches.hidden = !filtering || lastResults.length > 0;
    noMatches.textContent = `No tools match "${query.trim()}".`;
    searchStatus.textContent = filtering ? `${lastResults.length} ${lastResults.length === 1 ? 'tool' : 'tools'} found` : '';
  }

  search.addEventListener('input', applySearch);
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      const first = lastResults[0];
      if (first) {
        event.preventDefault();
        navigate({ name: 'tool', id: first.id });
      }
    } else if (event.key === 'ArrowDown') {
      const first = visibleLinks()[0];
      if (first) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === 'Escape') {
      if (search.value !== '') {
        event.preventDefault();
        event.stopPropagation();
        search.value = '';
        applySearch();
      }
    }
  });

  nav.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    const list = visibleLinks();
    const index = list.indexOf(document.activeElement as HTMLAnchorElement);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'Home') list[0]?.focus();
    else if (event.key === 'End') list[list.length - 1]?.focus();
    else if (event.key === 'ArrowDown') list[Math.min(index + 1, list.length - 1)]?.focus();
    else if (index === 0) search.focus();
    else list[index - 1]?.focus();
  });

  function focusSearch(): void {
    if (mobile.matches) openDrawer(false);
    search.focus();
    search.select();
  }

  // ---- Mobile drawer ----------------------------------------------------------------------
  function drawerOpen(): boolean {
    return document.body.classList.contains('nav-open');
  }

  function setToggle(open: boolean): void {
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? 'Close tool navigation' : 'Open tool navigation');
    replaceChildren(navToggle, icon(open ? 'close' : 'menu'));
  }

  function openDrawer(moveFocus = true): void {
    if (!mobile.matches || drawerOpen()) return;
    document.body.classList.add('nav-open');
    main.inert = true;
    scrim.hidden = false;
    setToggle(true);
    if (moveFocus) search.focus();
  }

  function closeDrawer(returnFocus: boolean): void {
    if (!drawerOpen()) return;
    document.body.classList.remove('nav-open');
    main.inert = false;
    scrim.hidden = true;
    setToggle(false);
    if (returnFocus) navToggle.focus();
  }

  setToggle(false);
  navToggle.addEventListener('click', () => (drawerOpen() ? closeDrawer(true) : openDrawer()));
  scrim.addEventListener('click', () => closeDrawer(true));
  mobile.addEventListener('change', () => closeDrawer(false));

  // ---- Theme ------------------------------------------------------------------------------
  function applyTheme(theme: string): void {
    document.documentElement.dataset.theme = theme;
    const next = theme === 'dark' ? 'light' : 'dark';
    themeToggle.setAttribute('aria-label', `Switch to ${next} theme`);
    themeToggle.title = `Switch to ${next} theme`;
    replaceChildren(themeToggle, icon(theme === 'dark' ? 'sun' : 'moon'));
  }
  applyTheme(prefs.get('theme'));
  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    prefs.set('theme', next);
    applyTheme(next);
    announce(`${next === 'dark' ? 'Dark' : 'Light'} theme`);
  });

  // ---- Keyboard shortcuts -----------------------------------------------------------------
  document.addEventListener('keydown', event => {
    // The Share dialog is modal: its own keys (Tab, Escape) are all that apply while it is open.
    if (shareDialog.element.open) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      focusSearch();
    } else if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditable(event.target)) {
      event.preventDefault();
      focusSearch();
    } else if (event.key === 'Escape' && drawerOpen()) {
      closeDrawer(true);
    }
  });

  byId('skip-link').addEventListener('click', event => {
    event.preventDefault();
    focusHeading();
  });

  // ---- Routing ----------------------------------------------------------------------------
  function navigate(route: Route): void {
    const hash = formatRoute(route);
    if (location.hash === hash) render(true);
    else location.hash = hash;
  }

  function focusHeading(): void {
    const visible = [...view.children].find(c => !(c as HTMLElement).hidden) as HTMLElement | undefined;
    const heading = visible?.querySelector<HTMLElement>('h1');
    (heading ?? main).focus({ preventScroll: false });
  }

  function setCurrent(route: Route): void {
    if (route.name === 'home') homeLink.setAttribute('aria-current', 'page');
    else homeLink.removeAttribute('aria-current');
    for (const [id, link] of links) {
      if (route.name === 'tool' && route.id === id) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  // ---- Share links ------------------------------------------------------------------------
  /** The Share button at the top of a tool, added once the tool has drawn its page. */
  function addShareButton(tool: AvailableTool, slot: MountedTool): void {
    const header = slot.root.querySelector<HTMLElement>('.tool-page > .page-header');
    if (!header) return;
    const share = h('button', { type: 'button', class: 'btn btn-secondary share-button', id: `share-${tool.id}`, 'aria-haspopup': 'dialog' },
      icon('link'), h('span', null, 'Share'));
    share.addEventListener('click', () => shareDialog.open({ id: tool.id, name: tool.name, link: toolLink(tool.id), share: slot.instance?.share ?? null }, share));
    header.appendChild(share);
  }

  /**
   * The address that settings were last taken from. Coming back to it with Back or Forward does
   * not apply them again, so work done since is never overwritten by an old link.
   */
  let linkUsed: string | null = null;

  function applyLink(tool: AvailableTool, slot: MountedTool): void {
    const hash = location.hash;
    if (hash === linkUsed) return;
    const read = readShareQuery(hash);
    if (read.kind === 'none' || (read.kind === 'settings' && read.params.size === 0)) return;
    linkUsed = hash;
    let problem: string | null = null;
    if (read.kind === 'refused') problem = REFUSED_TEXT[read.reason];
    else if (!slot.instance?.share) problem = REFUSED_TEXT.unsupported;
    else {
      let applied = false;
      try {
        applied = slot.instance.share.apply(read.params);
      } catch {
        applied = false;
      }
      if (!applied) problem = REFUSED_TEXT.invalid;
    }
    if (problem === null) {
      toast(`Opened ${tool.name} with the settings from the link`);
      announce(`Opened ${tool.name} with the settings from the link.`);
      return;
    }
    const text = `The settings in this link were not used: ${problem}. ${tool.name} opened as it normally does.`;
    const dismiss = h('button', { type: 'button', class: 'btn btn-ghost link-notice-dismiss' }, 'Dismiss');
    const box = h('div', { class: 'notice notice-warning link-notice', id: 'link-notice' }, icon('warning'), h('div', { class: 'notice-body' }, h('p', null, text)), dismiss);
    dismiss.addEventListener('click', () => { box.remove(); focusHeading(); });
    slot.root.prepend(box);
    announce(text);
  }

  function showPage(node: HTMLElement): void {
    pageNode?.remove();
    pageNode = node;
    view.appendChild(node);
  }

  async function render(userInitiated: boolean): Promise<void> {
    const token = ++renderToken;
    const route = parseRoute(location.hash);
    currentToolId = route.name === 'tool' ? route.id : null;
    for (const slot of mounted.values()) slot.root.hidden = true;
    // A notice about a refused link belongs to that visit only.
    for (const old of view.querySelectorAll('.link-notice')) old.remove();
    pageNode?.remove();
    pageNode = null;
    setCurrent(route);
    closeDrawer(false);

    if (route.name === 'home') {
      document.title = `${APP_TITLE} | Local-first IT and network engineering toolbox`;
      showPage(homePage(registry));
    } else if (route.name === 'about') {
      document.title = `About | ${APP_TITLE}`;
      showPage(aboutPage(prefs, () => {
        prefs.clear();
        applyTheme(prefs.get('theme'));
        services.announce('Preferences cleared.');
        toast('Preferences cleared');
      }));
    } else {
      const tool = registry.get(route.id);
      if (!tool) {
        document.title = `Not found | ${APP_TITLE}`;
        showPage(notFoundPage(route.id));
      } else if (tool.status === 'planned') {
        document.title = `${tool.name} (planned) | ${APP_TITLE}`;
        showPage(plannedPage(tool, registry.categoryName(tool.category)));
      } else {
        document.title = `${tool.name} | ${APP_TITLE}`;
        prefs.set('lastTool', tool.id);
        let slot = mounted.get(tool.id);
        if (!slot) {
          const root = h('div', { class: 'tool-slot', 'data-slot': tool.id }, h('p', { class: 'loading' }, `Loading ${tool.name}...`));
          slot = { root, instance: undefined };
          mounted.set(tool.id, slot);
          view.appendChild(root);
          try {
            const module = await tool.load();
            replaceChildren(root);
            slot.instance = module.mount(root, services, tool, registry.categoryName(tool.category));
            addShareButton(tool, slot);
          } catch {
            mounted.delete(tool.id);
            root.remove();
            if (token === renderToken) {
              showPage(h('div', { class: 'page' }, h('div', { class: 'notice notice-error' }, icon('error'), h('div', { class: 'notice-body' }, `${tool.name} could not be loaded. If you are offline, reconnect once so NetForge can save it for offline use, then reload.`))));
            }
            return;
          }
          if (token !== renderToken) {
            // The user moved on while the module loaded; show it only if they came back to it.
            root.hidden = currentToolId !== tool.id;
            return;
          }
        } else {
          slot.instance?.activate?.();
        }
        slot.root.hidden = false;
        applyLink(tool, slot);
      }
    }
    if (userInitiated) {
      window.scrollTo({ top: 0 });
      focusHeading();
    }
  }

  window.addEventListener('hashchange', () => { void render(true); });

  // With no route in the address, reopen the last tool used on this device.
  if (location.hash === '' || location.hash === '#') {
    const last = registry.get(prefs.get('lastTool'));
    if (last && last.status === 'available') history.replaceState(null, '', formatRoute({ name: 'tool', id: last.id }));
  }
  applySearch();
  void render(false);
}
