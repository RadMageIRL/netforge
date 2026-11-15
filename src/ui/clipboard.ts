/**
 * Copying text. The async Clipboard API is used where the browser allows it (secure contexts); a
 * hidden textarea and execCommand('copy') cover plain-HTTP and older contexts. Nothing is read
 * from the clipboard, ever.
 */

/**
 * `host` is where the fallback's hidden buffer goes: an open modal dialog makes the rest of the
 * page inert, so a buffer outside it could not be selected.
 */
export async function copyText(text: string, host: HTMLElement = document.body): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied or document not focused: try the fallback.
    }
  }
  if (!legacyCopy(text, host)) throw new Error('The browser did not allow copying.');
}

function legacyCopy(text: string, host: HTMLElement): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const buffer = document.createElement('textarea');
  buffer.value = text;
  buffer.setAttribute('readonly', '');
  buffer.setAttribute('aria-hidden', 'true');
  buffer.className = 'clipboard-buffer';
  host.appendChild(buffer);
  buffer.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  buffer.remove();
  previous?.focus({ preventScroll: true });
  return copied;
}
