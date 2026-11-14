/** Saving generated text as a file. The file is built in memory; nothing is uploaded. */
import { safeFilename } from '../core/export/files';

export function downloadText(filename: string, text: string, mime = 'text/plain'): string {
  const name = safeFilename(filename);
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.className = 'visually-hidden';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return name;
}
