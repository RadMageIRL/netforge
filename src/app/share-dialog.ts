/**
 * The Share dialog. It shows the plain link to a tool and, for a tool with harmless settings, a
 * second link that carries them, listing what that link holds before anything is copied. Copying
 * is the only thing it does: it never changes the address bar and never sends anything.
 */
import { copyText } from '../ui/clipboard';
import { h, replaceChildren } from '../ui/dom';
import { icon } from '../ui/icons';
import type { ToolShare } from './registry';
import { settingsLink } from './share';

export interface ShareTarget {
  readonly id: string;
  readonly name: string;
  readonly link: string;
  /** The tool's settings links, or null for a tool that shares its route only. */
  readonly share: ToolShare | null;
}

export interface ShareDialog {
  open(target: ShareTarget, opener: HTMLElement): void;
  readonly element: HTMLDialogElement;
}

export function createShareDialog(announce: (message: string) => void): ShareDialog {
  const title = h('h2', { class: 'share-title', id: 'share-title' });
  const close = h('button', { type: 'button', class: 'btn btn-ghost btn-icon', id: 'share-close', 'aria-label': 'Close' }, icon('close'));
  const body = h('div', { class: 'share-body' });
  const status = h('p', { class: 'share-status', id: 'share-status', role: 'status' });
  const dialog = h('dialog', { class: 'share-dialog', id: 'share-dialog', 'aria-labelledby': 'share-title' },
    h('div', { class: 'share-head' }, title, close),
    body,
    status,
  );
  let opener: HTMLElement | null = null;

  close.addEventListener('click', () => dialog.close());
  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    replaceChildren(body);
    replaceChildren(status);
    opener?.focus();
    opener = null;
  });

  function linkRow(id: string, label: string, link: string, buttonLabel: string, copied: string): { row: HTMLElement; button: HTMLButtonElement } {
    const box = h('input', { class: 'input mono share-link', id, type: 'text', readonly: true, value: link, 'aria-label': label, spellcheck: 'false' });
    const button = h('button', { type: 'button', class: 'btn btn-primary share-copy', id: `${id}-copy` }, icon('copy'), h('span', null, buttonLabel));
    box.addEventListener('focus', () => box.select());
    button.addEventListener('click', async () => {
      try {
        await copyText(link, dialog);
        button.classList.add('copied');
        window.setTimeout(() => button.classList.remove('copied'), 1500);
        status.textContent = copied;
        announce(copied);
      } catch {
        box.focus();
        box.select();
        status.textContent = 'Copy did not work here. The link is selected in the box: copy it from there.';
      }
    });
    return { row: h('div', { class: 'share-row' }, box, button), button };
  }

  function open(target: ShareTarget, from: HTMLElement): void {
    opener = from;
    replaceChildren(status);
    title.textContent = `Share ${target.name}`;
    const plain = linkRow('share-tool-link', `Link to ${target.name}`, target.link, 'Copy link', `Copied the link to ${target.name}.`);
    const sections: HTMLElement[] = [
      h('section', { class: 'share-option', 'aria-labelledby': 'share-tool-heading' },
        h('h3', { class: 'share-heading', id: 'share-tool-heading' }, 'Link to this tool'),
        h('p', { class: 'share-text' }, `Opens ${target.name} with nothing filled in.`),
        plain.row,
      ),
    ];
    if (target.share) {
      const offer = target.share.offer();
      const link = offer.ok ? settingsLink(target.id, offer.params) : null;
      const content: HTMLElement[] = [h('h3', { class: 'share-heading', id: 'share-settings-heading' }, 'Link with these settings')];
      if (!offer.ok) content.push(h('p', { class: 'share-text', id: 'share-settings-unavailable' }, offer.reason));
      else if (link === null) content.push(h('p', { class: 'share-text', id: 'share-settings-unavailable' }, 'These settings are too long to put in a link. Share the link to the tool instead.'));
      else {
        content.push(
          h('p', { class: 'share-text' }, `Opens ${target.name} with:`),
          h('ul', { class: 'share-summary', id: 'share-summary' }, offer.summary.map(line => h('li', null, line))),
          linkRow('share-settings-link', `Link to ${target.name} with these settings`, link, 'Copy link with settings', `Copied the link to ${target.name} with these settings.`).row,
          h('p', { class: 'source-note' }, 'Nothing else you entered is included, and nothing runs when the link is opened.'),
        );
      }
      sections.push(h('section', { class: 'share-option', 'aria-labelledby': 'share-settings-heading' }, ...content));
    } else {
      sections.push(h('p', { class: 'share-text share-private', id: 'share-private' },
        `Links to ${target.name} never carry what you entered: tokens, keys, plans, scripts and pasted text stay on this device.`));
    }
    sections.push(h('p', { class: 'source-note' }, 'Settings travel after the # in the address, which browsers never send to a server.'));
    replaceChildren(body, sections);
    dialog.showModal();
    plain.button.focus();
  }

  return { open, element: dialog };
}
