/**
 * Copying text. The async Clipboard API is used where the browser allows it (secure contexts); a
 * hidden textarea and execCommand('copy') cover plain-HTTP and older contexts. Nothing is read
 * from the clipboard, ever.
 */

export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied or document not focused: try the fallback.
    }
  }
  if (!legacyCopy(text)) throw new Error('The browser did not allow copying.');
}

function legacyCopy(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const buffer = document.createElement('textarea');
  buffer.value = text;
  buffer.setAttribute('readonly', '');
  buffer.setAttribute('aria-hidden', 'true');
  buffer.className = 'clipboard-buffer';
  document.body.appendChild(buffer);
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
