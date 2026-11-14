/**
 * Unix file mode bits: the nine read/write/execute bits for owner, group and others, plus setuid,
 * setgid and the sticky bit. Parsing and formatting of octal modes and "ls -l" strings, and the
 * chmod symbolic language applied to a starting mode.
 *
 * Symbolic clauses follow POSIX chmod as GNU coreutils implements it (checked against GNU chmod):
 * - who is any of u g o a; with no who, the change applies to everyone but leaves alone the bits
 *   set in the umask;
 * - operators + - =, several per clause (u=rw,g+r-w);
 * - permissions r w x X s t, or one of u g o to copy that class's current bits;
 * - X means execute only for a directory, or when some execute bit is already set;
 * - on a directory GNU chmod keeps setuid and setgid unless the clause names them.
 *
 * These are Unix permission bits. Windows NTFS uses access control lists, a different model;
 * nothing here converts between the two.
 */
import { ok, fail, type Result } from '../result';

export const S_ISUID = 0o4000;
export const S_ISGID = 0o2000;
export const S_ISVTX = 0o1000;
export const MODE_MASK = 0o7777;

export type PermClass = 'u' | 'g' | 'o';
export const CLASSES: readonly PermClass[] = ['u', 'g', 'o'];
export const CLASS_NAME: Readonly<Record<PermClass, string>> = { u: 'Owner', g: 'Group', o: 'Others' };
const CLASS_SHIFT: Readonly<Record<PermClass, number>> = { u: 6, g: 3, o: 0 };
const CLASS_SPECIAL: Readonly<Record<PermClass, number>> = { u: S_ISUID, g: S_ISGID, o: S_ISVTX };

export const CHMOD_LIMITS = {
  /** Longest symbolic expression, in characters. */
  symbolicChars: 200,
  /** Longest path, in characters. */
  pathChars: 4096,
} as const;

export type ChmodErrorCode =
  | 'empty' | 'octal-digits' | 'octal-length' | 'ls-length' | 'ls-char' | 'too-long'
  | 'clause-empty' | 'clause-operator' | 'clause-char' | 'umask' | 'path-control' | 'path-too-long';

/** The bit for one permission of one class: bit('g', 'w') is 0o020. */
export function bit(cls: PermClass, perm: 'r' | 'w' | 'x'): number {
  return (perm === 'r' ? 4 : perm === 'w' ? 2 : 1) << CLASS_SHIFT[cls];
}

/** An octal mode of 3 or 4 digits: 755, 0644, 2775. */
export function parseOctalMode(text: string): Result<number, ChmodErrorCode> {
  const t = text.trim();
  if (t === '') return fail('empty', 'Enter an octal mode such as 755.');
  const bad = /[^0-7]/.exec(t);
  if (bad) return fail('octal-digits', `"${bad[0]}" is not an octal digit. A mode uses the digits 0 to 7 only.`, text.indexOf(t) + bad.index);
  if (t.length < 3 || t.length > 4) return fail('octal-length', 'Enter 3 digits (owner, group, others) or 4 (special bits first), such as 755 or 2775.');
  return ok(parseInt(t, 8));
}

/** A umask of 1 to 4 octal digits; only the nine permission bits count. */
export function parseUmask(text: string): Result<number, ChmodErrorCode> {
  const t = text.trim();
  if (!/^[0-7]{1,4}$/.test(t)) return fail('umask', 'Enter the umask as 1 to 4 octal digits, such as 022.');
  return ok(parseInt(t, 8) & 0o777);
}

/** Three digits when no special bit is set, four otherwise. */
export function formatOctal(mode: number): string {
  const m = mode & MODE_MASK;
  return m.toString(8).padStart(m > 0o777 ? 4 : 3, '0');
}

/** Always four digits: 0755. */
export function formatOctal4(mode: number): string {
  return (mode & MODE_MASK).toString(8).padStart(4, '0');
}

function classTriplet(mode: number, cls: PermClass): string {
  const special = (mode & CLASS_SPECIAL[cls]) !== 0;
  const x = (mode & bit(cls, 'x')) !== 0;
  const mark = cls === 'o' ? 't' : 's';
  return (mode & bit(cls, 'r') ? 'r' : '-') + (mode & bit(cls, 'w') ? 'w' : '-')
    + (special ? (x ? mark : mark.toUpperCase()) : x ? 'x' : '-');
}

/** The nine characters "ls -l" shows after the file type: rwxr-sr-t. */
export function formatLs(mode: number): string {
  return CLASSES.map(c => classTriplet(mode, c)).join('');
}

const FILE_TYPES = '-dlbcps';

export interface LsMode {
  readonly mode: number;
  /** The leading file type character, when one was given. */
  readonly type: string | null;
}

/** Reads rwxr-xr-x, with an optional file type in front (drwxr-xr-x) and an optional trailing "." or "+" as ls prints. */
export function parseLsMode(text: string): Result<LsMode, ChmodErrorCode> {
  let t = text.trim();
  if (t === '') return fail('empty', 'Enter a permission string such as rwxr-xr-x.');
  const lead = text.indexOf(t);
  if (t.length === 11 && /[.+]$/.test(t)) t = t.slice(0, 10);
  if (t.length !== 9 && t.length !== 10) return fail('ls-length', 'A permission string has 9 characters (rwxr-xr-x), or 10 with the file type in front (drwxr-xr-x).');
  let type: string | null = null;
  let offset = 0;
  if (t.length === 10) {
    type = t.charAt(0);
    if (!FILE_TYPES.includes(type)) return fail('ls-char', `"${type}" is not a file type character. Expected one of ${FILE_TYPES.split('').join(' ')}.`, lead);
    offset = 1;
  }
  let mode = 0;
  for (let i = 0; i < 9; i++) {
    const ch = t.charAt(offset + i);
    const cls = CLASSES[Math.floor(i / 3)];
    const slot = i % 3;
    const at = lead + offset + i;
    if (ch === '-') continue;
    if (slot === 0 && ch === 'r') mode |= bit(cls, 'r');
    else if (slot === 1 && ch === 'w') mode |= bit(cls, 'w');
    else if (slot === 2 && ch === 'x') mode |= bit(cls, 'x');
    else if (slot === 2 && cls !== 'o' && (ch === 's' || ch === 'S')) mode |= CLASS_SPECIAL[cls] | (ch === 's' ? bit(cls, 'x') : 0);
    else if (slot === 2 && cls === 'o' && (ch === 't' || ch === 'T')) mode |= S_ISVTX | (ch === 't' ? bit('o', 'x') : 0);
    else {
      const expected = slot === 0 ? 'r or -' : slot === 1 ? 'w or -' : cls === 'o' ? 'x, t, T or -' : 'x, s, S or -';
      return fail('ls-char', `Character ${offset + i + 1} is "${ch}"; expected ${expected} for ${CLASS_NAME[cls].toLowerCase()}.`, at);
    }
  }
  return ok({ mode, type });
}

/**
 * The mode as one chmod expression that sets every bit: u=rwx,g=rx,o=rx (with s and t where set).
 * GNU chmod keeps setuid and setgid on a directory unless a clause names them, so for a directory
 * a clause that removes the ones not wanted is added: u=rwx,g=rx,o=rx,ug-s.
 */
export function formatSymbolic(mode: number, directory = false): string {
  const clauses = CLASSES.map(cls => {
    let perms = (mode & bit(cls, 'r') ? 'r' : '') + (mode & bit(cls, 'w') ? 'w' : '') + (mode & bit(cls, 'x') ? 'x' : '');
    if (mode & CLASS_SPECIAL[cls]) perms += cls === 'o' ? 't' : 's';
    return `${cls}=${perms}`;
  });
  if (directory) {
    const clear = (mode & S_ISUID ? '' : 'u') + (mode & S_ISGID ? '' : 'g');
    if (clear !== '') clauses.push(`${clear}-s`);
  }
  return clauses.join(',');
}

export interface ApplyOptions {
  readonly directory: boolean;
  /** The process umask; it matters only for clauses with no who. */
  readonly umask: number;
}

const WHO_MASK: Readonly<Record<string, number>> = {
  u: S_ISUID | 0o700,
  g: S_ISGID | 0o070,
  o: S_ISVTX | 0o007,
  a: MODE_MASK,
};
const R_ALL = 0o444;
const W_ALL = 0o222;
const X_ALL = 0o111;
const COPY_MASK: Readonly<Record<string, number>> = { u: 0o700, g: 0o070, o: 0o007 };

interface Change {
  readonly op: '+' | '-' | '=';
  /** Bits of the who list; 0 when no who was given. */
  readonly affected: number;
  readonly value: number;
  readonly kind: 'ordinary' | 'copy' | 'x-if-any-x';
  /** Special bits the change names, which a directory would otherwise keep. */
  readonly mentioned: number;
}

function parseSymbolic(text: string): Result<Change[], ChmodErrorCode> {
  if (text.length > CHMOD_LIMITS.symbolicChars) return fail('too-long', `Keep the expression to ${CHMOD_LIMITS.symbolicChars} characters.`);
  const t = text.trim();
  if (t === '') return fail('empty', 'Enter a symbolic mode such as u+x or go-w.');
  const lead = text.indexOf(t);
  const changes: Change[] = [];
  let i = 0;
  for (;;) {
    let affected = 0;
    const clauseStart = i;
    while (i < t.length && 'ugoa'.includes(t.charAt(i))) affected |= WHO_MASK[t.charAt(i++)];
    if (i >= t.length || !'+-='.includes(t.charAt(i))) {
      if (i === clauseStart && (i >= t.length || t.charAt(i) === ',')) return fail('clause-empty', 'A clause is empty. Write clauses such as u+x separated by single commas.', lead + i);
      if (i >= t.length || t.charAt(i) === ',') return fail('clause-operator', 'A clause needs an operator: + to add, - to remove or = to set exactly.', lead + i);
      return fail('clause-char', `"${t.charAt(i)}" is not expected here. Start a clause with any of u g o a, then + - or =.`, lead + i);
    }
    while (i < t.length && '+-='.includes(t.charAt(i))) {
      const op = t.charAt(i++) as Change['op'];
      const next = t.charAt(i);
      if (i < t.length && 'ugo'.includes(next)) {
        i++;
        changes.push({ op, affected, value: COPY_MASK[next], kind: 'copy', mentioned: 0 });
        continue;
      }
      let value = 0;
      let kind: Change['kind'] = 'ordinary';
      for (; i < t.length; i++) {
        const c = t.charAt(i);
        if (c === 'r') value |= R_ALL;
        else if (c === 'w') value |= W_ALL;
        else if (c === 'x') value |= X_ALL;
        else if (c === 'X') kind = 'x-if-any-x';
        else if (c === 's') value |= S_ISUID | S_ISGID;
        else if (c === 't') value |= S_ISVTX;
        else break;
      }
      changes.push({ op, affected, value, kind, mentioned: affected ? affected & value : value });
    }
    if (i >= t.length) break;
    if (t.charAt(i) !== ',') return fail('clause-char', `"${t.charAt(i)}" is not expected here. Permissions are r w x X s t, or one of u g o to copy a class.`, lead + i);
    i++;
  }
  return ok(changes);
}

/** Applies a chmod symbolic expression (u+x,go-w) to a mode. */
export function applySymbolic(mode: number, text: string, options: ApplyOptions): Result<number, ChmodErrorCode> {
  const parsed = parseSymbolic(text);
  if (!parsed.ok) return parsed;
  let m = mode & MODE_MASK;
  for (const change of parsed.value) {
    const keep = (options.directory ? S_ISUID | S_ISGID : 0) & ~change.mentioned;
    let value = change.value;
    if (change.kind === 'copy') {
      value &= m;
      value = (value & R_ALL ? R_ALL : 0) | (value & W_ALL ? W_ALL : 0) | (value & X_ALL ? X_ALL : 0);
    } else if (change.kind === 'x-if-any-x') {
      if ((m & X_ALL) !== 0 || options.directory) value |= X_ALL;
    }
    value &= (change.affected ? change.affected : ~options.umask & MODE_MASK) & ~keep;
    if (change.op === '=') {
      const preserved = (change.affected ? ~change.affected & MODE_MASK : 0) | keep;
      m = (m & preserved) | value;
    } else if (change.op === '+') {
      m |= value;
    } else {
      m &= ~value;
    }
  }
  return ok(m & MODE_MASK);
}

/**
 * What "chmod <digits>" leaves on a file or directory that had `current`. On a file the digits
 * replace every bit. On a directory GNU chmod keeps setuid and setgid that the digits do not set,
 * unless the mode is written with five or more digits (00755).
 */
export function applyNumeric(current: number, digits: string, directory: boolean): Result<number, ChmodErrorCode> {
  const t = digits.trim();
  if (t === '') return fail('empty', 'Enter an octal mode such as 755.');
  if (!/^[0-7]+$/.test(t)) return fail('octal-digits', 'A mode uses the digits 0 to 7 only.');
  const value = parseInt(t, 8);
  if (t.length > 12 || value > MODE_MASK) return fail('octal-length', 'The mode is larger than 7777.');
  if (!directory || t.length > 4) return ok(value);
  return ok(value | (current & (S_ISUID | S_ISGID)));
}

/** A path as one POSIX shell word, in single quotes. */
export function shellQuote(path: string): Result<string, ChmodErrorCode> {
  if (path.length > CHMOD_LIMITS.pathChars) return fail('path-too-long', `Keep the path to ${CHMOD_LIMITS.pathChars} characters.`);
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) {
      return fail('path-control', 'The path contains a control character or line break, which cannot be written safely on one command line.', i);
    }
  }
  if (/^[A-Za-z0-9_./-]+$/.test(path)) return ok(path);
  return ok(`'${path.replace(/'/g, `'\\''`)}'`);
}

export const PATH_PLACEHOLDER = '<PATH>';

export interface ChmodCommands {
  readonly octal: string;
  readonly symbolic: string;
  /** True when no path was given and the commands hold a placeholder. */
  readonly template: boolean;
}

/**
 * chmod command lines for a mode. The path is quoted for a POSIX shell; "--" guards a path that
 * starts with "-". For a directory the symbolic command also clears setuid and setgid that the mode
 * does not have; the octal command cannot (see applyNumeric).
 */
export function chmodCommands(mode: number, path: string, directory = false): Result<ChmodCommands, ChmodErrorCode> {
  const template = path === '';
  let target = PATH_PLACEHOLDER;
  if (!template) {
    const quoted = shellQuote(path);
    if (!quoted.ok) return quoted;
    target = path.startsWith('-') ? `-- ${quoted.value}` : quoted.value;
  }
  return ok({ octal: `chmod ${formatOctal4(mode)} ${target}`, symbolic: `chmod ${formatSymbolic(mode, directory)} ${target}`, template });
}

export interface BitExplanation {
  readonly label: string;
  readonly set: boolean;
  readonly meaning: string;
}

/** What each of the twelve bits means for a regular file or for a directory. */
export function explainMode(mode: number, directory: boolean): BitExplanation[] {
  const out: BitExplanation[] = [];
  for (const cls of CLASSES) {
    const who = cls === 'u' ? 'The owner' : cls === 'g' ? 'Members of the group' : 'Everyone else';
    const r = (mode & bit(cls, 'r')) !== 0;
    const w = (mode & bit(cls, 'w')) !== 0;
    const x = (mode & bit(cls, 'x')) !== 0;
    const can = (set: boolean) => (set ? 'can' : 'cannot');
    out.push(
      { label: `${CLASS_NAME[cls]} read`, set: r, meaning: directory ? `${who} ${can(r)} list the names in the directory.` : `${who} ${can(r)} read the file.` },
      { label: `${CLASS_NAME[cls]} write`, set: w, meaning: directory ? `${who} ${can(w)} create, rename and delete entries in the directory (this also needs execute).` : `${who} ${can(w)} change the file.` },
      { label: `${CLASS_NAME[cls]} execute`, set: x, meaning: directory ? `${who} ${can(x)} enter the directory and reach the files inside it (search permission).` : `${who} ${can(x)} run the file as a program.` },
    );
  }
  const suid = (mode & S_ISUID) !== 0;
  const sgid = (mode & S_ISGID) !== 0;
  const sticky = (mode & S_ISVTX) !== 0;
  out.push(
    { label: 'setuid', set: suid, meaning: directory
      ? (suid ? 'Set, but Linux ignores setuid on a directory. Some other systems give it a meaning.' : 'Not set. Linux ignores setuid on a directory.')
      : (suid ? 'A program runs with the rights of the file\'s owner, not of the person who starts it. It needs an execute bit to have any effect.' : 'Not set: a program runs with the rights of the person who starts it.') },
    { label: 'setgid', set: sgid, meaning: directory
      ? (sgid ? 'New files and directories created inside take the directory\'s group, and new subdirectories get setgid too.' : 'Not set: new entries take the group of the process that creates them.')
      : (sgid ? 'A program runs with the rights of the file\'s group. Without group execute, some systems use this bit for mandatory locking instead.' : 'Not set: a program runs with the groups of the person who starts it.') },
    { label: 'sticky', set: sticky, meaning: directory
      ? (sticky ? 'Only an entry\'s owner, the directory\'s owner or root can rename or delete entries, as in /tmp.' : 'Not set: anyone with write permission on the directory can rename or delete any entry in it.')
      : (sticky ? 'Set, but Linux ignores the sticky bit on a regular file.' : 'Not set. Linux ignores the sticky bit on a regular file.') },
  );
  return out;
}

export interface ModeWarning {
  readonly code: 'world-writable' | 'world-writable-no-sticky' | 'all-open' | 'no-access' | 'setuid-writable' | 'setgid-writable' | 'special-no-exec' | 'owner-locked-out' | 'write-no-exec-dir' | 'group-more-than-owner';
  readonly message: string;
}

/** Modes that are legal but usually a mistake or a risk. */
export function modeWarnings(mode: number, directory: boolean): ModeWarning[] {
  const out: ModeWarning[] = [];
  const m = mode & MODE_MASK;
  const perms = m & 0o777;
  if (perms === 0o777 && !directory) out.push({ code: 'all-open', message: 'Mode 777 lets every account on the system read, change and run the file.' });
  else if (perms === 0o777 && !(m & S_ISVTX)) out.push({ code: 'all-open', message: 'Mode 777 lets every account on the system list, create and delete entries here.' });
  if (perms === 0) out.push({ code: 'no-access', message: 'No permission bits are set: only root, or the owner after changing the mode again, can use it.' });
  if (m & 0o002) {
    if (!directory) {
      if (perms !== 0o777) out.push({ code: 'world-writable', message: 'Others have write permission: any account on the system can change the file.' });
    } else if (!(m & S_ISVTX)) {
      if (perms !== 0o777) out.push({ code: 'world-writable-no-sticky', message: 'Others can write to the directory and the sticky bit is not set, so any account can delete or replace entries it does not own.' });
    }
  }
  if (!directory && (m & S_ISUID) && (m & 0o022)) out.push({ code: 'setuid-writable', message: 'A setuid file that group or others can write to lets them replace a program that runs with the owner\'s rights.' });
  if (!directory && (m & S_ISGID) && (m & 0o002)) out.push({ code: 'setgid-writable', message: 'A setgid file that others can write to lets them replace a program that runs with the group\'s rights.' });
  if (!directory && (((m & S_ISUID) && !(m & 0o100)) || ((m & S_ISGID) && !(m & 0o010)))) out.push({ code: 'special-no-exec', message: 'setuid or setgid is set without the matching execute bit (shown as a capital S), so it does not make a program run with other rights.' });
  if (directory && (m & S_ISVTX) && !(m & 0o001)) out.push({ code: 'special-no-exec', message: 'The sticky bit is set without execute for others (shown as a capital T).' });
  if (perms !== 0 && !(m & 0o400)) out.push({ code: 'owner-locked-out', message: 'The owner has no read permission while other bits are set. Classes are checked in order, so the owner is refused even where group or others are allowed.' });
  if (directory) {
    for (const cls of CLASSES) {
      if ((m & bit(cls, 'w')) && !(m & bit(cls, 'x'))) {
        out.push({ code: 'write-no-exec-dir', message: `${CLASS_NAME[cls]} has write without execute on a directory. Creating or deleting entries needs both, so the write bit has no effect.` });
        break;
      }
    }
  }
  const u = (m >> 6) & 7;
  const g = (m >> 3) & 7;
  const o = m & 7;
  if ((m & 0o400) && ((g & ~u) !== 0 || (o & ~u) !== 0)) out.push({ code: 'group-more-than-owner', message: 'Group or others have a permission the owner lacks. The owner is still limited to the owner bits.' });
  return out;
}
