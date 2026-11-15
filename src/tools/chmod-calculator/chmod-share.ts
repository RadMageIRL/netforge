/**
 * chmod Calculator settings links: the twelve mode bits and whether they apply to a file or a
 * directory. The path and the change previews are never included.
 */
import { formatLs, formatOctal, formatOctal4, parseOctalMode } from '../../core/perm/chmod';
import { oneOf, onlyKeys, type ShareOffer } from '../../app/share';

export interface ChmodShare {
  readonly mode: number;
  readonly directory: boolean;
}

const KEYS = ['mode', 'type'] as const;

export function chmodOffer(s: ChmodShare): ShareOffer {
  return {
    ok: true,
    params: [['mode', formatOctal(s.mode)], ['type', s.directory ? 'directory' : 'file']],
    summary: [`Mode ${formatOctal4(s.mode)} (${formatLs(s.mode)})`, `Applies to a ${s.directory ? 'directory' : 'file'}`, 'Not included: the path and the change previews'],
  };
}

export function readChmodShare(params: ReadonlyMap<string, string>): ChmodShare | null {
  if (!onlyKeys(params, KEYS)) return null;
  const text = params.get('mode');
  if (text === undefined || !/^[0-7]{3,4}$/.test(text)) return null;
  const mode = parseOctalMode(text);
  if (!mode.ok) return null;
  const type = params.has('type') ? oneOf(params.get('type'), ['file', 'directory'] as const) : 'file';
  if (type === null) return null;
  return { mode: mode.value, directory: type === 'directory' };
}
