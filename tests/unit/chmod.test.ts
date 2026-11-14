/** chmod Calculator: mode parsing and formatting, symbolic and numeric changes, quoting, explanations and warnings. */
import { describe, expect, it } from 'vitest';
import {
  applyNumeric, applySymbolic, bit, chmodCommands, CHMOD_LIMITS, explainMode, formatLs, formatOctal, formatOctal4, formatSymbolic,
  modeWarnings, parseLsMode, parseOctalMode, parseUmask, PATH_PLACEHOLDER, shellQuote,
} from '../../src/core/perm/chmod';

type R<T> = { ok: true; value: T } | { ok: false; error: { code: string; offset?: number } };
function value<T>(r: R<T>): T {
  if (!r.ok) throw new Error(`unexpected error ${r.error.code}`);
  return r.value;
}
const code = (r: R<unknown>) => (r.ok ? 'ok' : r.error.code);
const offset = (r: R<unknown>) => (r.ok ? undefined : r.error.offset);
const oct = (n: number) => n.toString(8);

const file = (start: number, expr: string, umask = 0o022) => oct(value(applySymbolic(start, expr, { directory: false, umask })));
const dir = (start: number, expr: string, umask = 0o022) => oct(value(applySymbolic(start, expr, { directory: true, umask })));

describe('octal modes', () => {
  it('reads 3 or 4 digits', () => {
    expect(value(parseOctalMode('755'))).toBe(0o755);
    expect(value(parseOctalMode('0644'))).toBe(0o644);
    expect(value(parseOctalMode('2775'))).toBe(0o2775);
    expect(value(parseOctalMode('7777'))).toBe(0o7777);
    expect(value(parseOctalMode('000'))).toBe(0);
    expect(value(parseOctalMode(' 600 '))).toBe(0o600);
  });

  it('refuses other lengths, other digits and empty input', () => {
    expect(code(parseOctalMode(''))).toBe('empty');
    expect(code(parseOctalMode('  '))).toBe('empty');
    expect(code(parseOctalMode('75'))).toBe('octal-length');
    expect(code(parseOctalMode('7'))).toBe('octal-length');
    expect(code(parseOctalMode('07555'))).toBe('octal-length');
    expect(code(parseOctalMode('758'))).toBe('octal-digits');
    expect(offset(parseOctalMode('758'))).toBe(2);
    expect(offset(parseOctalMode(' 9'))).toBe(1);
    expect(code(parseOctalMode('rwx'))).toBe('octal-digits');
    expect(code(parseOctalMode('0o755'))).toBe('octal-digits');
    expect(code(parseOctalMode('-755'))).toBe('octal-digits');
  });

  it('formats with 3 digits, or 4 when a special bit is set', () => {
    expect(formatOctal(0o755)).toBe('755');
    expect(formatOctal(0)).toBe('000');
    expect(formatOctal(0o7)).toBe('007');
    expect(formatOctal(0o777)).toBe('777');
    expect(formatOctal(0o1000)).toBe('1000');
    expect(formatOctal(0o4755)).toBe('4755');
    expect(formatOctal(0o104755)).toBe('4755');
    expect(formatOctal4(0o755)).toBe('0755');
    expect(formatOctal4(0o2775)).toBe('2775');
    expect(formatOctal4(0)).toBe('0000');
    expect(formatOctal4(0o100644)).toBe('0644');
  });

  it('reads a umask of 1 to 4 digits and keeps the permission bits only', () => {
    expect(value(parseUmask('022'))).toBe(0o022);
    expect(value(parseUmask('2'))).toBe(0o002);
    expect(value(parseUmask('0077'))).toBe(0o077);
    expect(value(parseUmask('7777'))).toBe(0o777);
    for (const bad of ['', '8', '00022', 'u=rwx', '-22', '2 2']) expect(code(parseUmask(bad)), bad).toBe('umask');
  });
});

describe('permission strings', () => {
  it('names each bit', () => {
    expect([bit('u', 'r'), bit('u', 'w'), bit('u', 'x'), bit('g', 'r'), bit('g', 'w'), bit('g', 'x'), bit('o', 'r'), bit('o', 'w'), bit('o', 'x')])
      .toEqual([0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]);
  });

  it('formats like ls -l, with s, S, t and T', () => {
    expect(formatLs(0o755)).toBe('rwxr-xr-x');
    expect(formatLs(0o644)).toBe('rw-r--r--');
    expect(formatLs(0)).toBe('---------');
    expect(formatLs(0o4755)).toBe('rwsr-xr-x');
    expect(formatLs(0o4655)).toBe('rwSr-xr-x');
    expect(formatLs(0o2755)).toBe('rwxr-sr-x');
    expect(formatLs(0o2745)).toBe('rwxr-Sr-x');
    expect(formatLs(0o1777)).toBe('rwxrwxrwt');
    expect(formatLs(0o1776)).toBe('rwxrwxrwT');
    expect(formatLs(0o7777)).toBe('rwsrwsrwt');
    expect(formatLs(0o7000)).toBe('--S--S--T');
  });

  it('parses 9 characters, 10 with a file type, and a trailing ACL mark', () => {
    expect(value(parseLsMode('rwxr-xr-x'))).toEqual({ mode: 0o755, type: null });
    expect(value(parseLsMode('drwxr-xr-x'))).toEqual({ mode: 0o755, type: 'd' });
    expect(value(parseLsMode('-rw-r--r--'))).toEqual({ mode: 0o644, type: '-' });
    expect(value(parseLsMode('lrwxrwxrwx'))).toEqual({ mode: 0o777, type: 'l' });
    expect(value(parseLsMode('-rw-r--r--.'))).toEqual({ mode: 0o644, type: '-' });
    expect(value(parseLsMode('drwxr-xr-x+'))).toEqual({ mode: 0o755, type: 'd' });
    expect(value(parseLsMode('  rwsr-Sr-T '))).toEqual({ mode: 0o7744, type: null });
    expect(value(parseLsMode('---------')).mode).toBe(0);
    expect(value(parseLsMode('--S--S--T')).mode).toBe(0o7000);
    expect(value(parseLsMode('--s--s--t')).mode).toBe(0o7111);
    for (const t of '-dlbcps') expect(value(parseLsMode(`${t}---------`)).type).toBe(t);
  });

  it('refuses wrong lengths and characters in the wrong place, with the position', () => {
    expect(code(parseLsMode(''))).toBe('empty');
    expect(code(parseLsMode('rwx'))).toBe('ls-length');
    expect(code(parseLsMode('rwxr-xr-'))).toBe('ls-length');
    expect(code(parseLsMode('drwxr-xr-xx'))).toBe('ls-length');
    expect(code(parseLsMode('drwxr-xr-x++'))).toBe('ls-length');
    expect(code(parseLsMode('xrwxr-xr-x'))).toBe('ls-char');
    expect(offset(parseLsMode('xrwxr-xr-x'))).toBe(0);
    expect(code(parseLsMode('wrxr-xr-x'))).toBe('ls-char');
    expect(offset(parseLsMode('wrxr-xr-x'))).toBe(0);
    expect(offset(parseLsMode('rrxr-xr-x'))).toBe(1);
    expect(offset(parseLsMode('rwwr-xr-x'))).toBe(2);
    expect(offset(parseLsMode(' drwxr-xr-q'))).toBe(10);
    expect(code(parseLsMode('rwtr-xr-x'))).toBe('ls-char');
    expect(code(parseLsMode('rwxr-tr-x'))).toBe('ls-char');
    expect(code(parseLsMode('rwxr-xr-s'))).toBe('ls-char');
    expect(code(parseLsMode('rwxr-xr-S'))).toBe('ls-char');
    expect(code(parseLsMode('rwTr-xr-x'))).toBe('ls-char');
    expect(code(parseLsMode('swxr-xr-x'))).toBe('ls-char');
    expect(code(parseLsMode('rsxr-xr-x'))).toBe('ls-char');
    expect(code(parseLsMode('RWXR-XR-X'))).toBe('ls-char');
  });

  it('writes a symbolic form that names every class', () => {
    expect(formatSymbolic(0o755)).toBe('u=rwx,g=rx,o=rx');
    expect(formatSymbolic(0o640)).toBe('u=rw,g=r,o=');
    expect(formatSymbolic(0)).toBe('u=,g=,o=');
    expect(formatSymbolic(0o4755)).toBe('u=rwxs,g=rx,o=rx');
    expect(formatSymbolic(0o2770)).toBe('u=rwx,g=rwxs,o=');
    expect(formatSymbolic(0o1777)).toBe('u=rwx,g=rwx,o=rwxt');
    expect(formatSymbolic(0o7000)).toBe('u=s,g=s,o=t');
  });

  it('adds a clause for a directory that clears setuid and setgid the mode does not have', () => {
    expect(formatSymbolic(0o755, true)).toBe('u=rwx,g=rx,o=rx,ug-s');
    expect(formatSymbolic(0o2775, true)).toBe('u=rwx,g=rwxs,o=rx,u-s');
    expect(formatSymbolic(0o4755, true)).toBe('u=rwxs,g=rx,o=rx,g-s');
    expect(formatSymbolic(0o6755, true)).toBe('u=rwxs,g=rxs,o=rx');
    expect(formatSymbolic(0o1777, true)).toBe('u=rwx,g=rwx,o=rwxt,ug-s');
    expect(formatSymbolic(0o755, false)).toBe('u=rwx,g=rx,o=rx');
    // Without that clause GNU chmod would leave them set.
    expect(dir(0o7777, formatSymbolic(0))).toBe('6000');
    for (const mode of [0, 0o755, 0o2775, 0o4711, 0o1777, 0o7777, 0o6000, 0o640, 0o3000, 0o5001]) {
      for (const start of [0, 0o7777, 0o2755, 0o4000]) expect(dir(start, formatSymbolic(mode, true)), `${oct(mode)} from ${oct(start)}`).toBe(oct(mode));
    }
  });
});

describe('symbolic changes', () => {
  it('adds, removes and sets for the classes named', () => {
    expect(file(0o644, 'u+x')).toBe('744');
    expect(file(0o644, 'g+w')).toBe('664');
    expect(file(0o644, 'o-r')).toBe('640');
    expect(file(0o755, 'go-rx')).toBe('700');
    expect(file(0o600, 'a+r')).toBe('644');
    expect(file(0o777, 'a=r')).toBe('444');
    expect(file(0o777, 'o=')).toBe('770');
    expect(file(0o000, 'u=rwx,g=rx,o=rx')).toBe('755');
    expect(file(0o644, 'ug+x')).toBe('754');
    expect(file(0o000, 'ugo+r')).toBe('444');
  });

  it('applies several operators in one clause, left to right', () => {
    expect(file(0o000, 'u=rw,g+r-w')).toBe('640');
    expect(file(0o777, 'a-rwx+r')).toBe('444');
    expect(file(0o000, 'u+r-r+w')).toBe('200');
    expect(file(0o777, 'g=r+w')).toBe('767');
  });

  it('masks a change with no who by the umask', () => {
    expect(file(0o000, '+w', 0o022)).toBe('200');
    expect(file(0o000, '+w', 0o002)).toBe('220');
    expect(file(0o000, '+w', 0o000)).toBe('222');
    expect(file(0o000, '+rwx', 0o027)).toBe('750');
    expect(file(0o777, '-w', 0o022)).toBe('577');
    expect(file(0o777, '=r', 0o027)).toBe('440');
    expect(file(0o777, '=', 0o022)).toBe('0');
    expect(file(0o000, 'a+w', 0o022)).toBe('222');
    expect(file(0o000, '+x', 0o777)).toBe('0');
  });

  it('copies a class with u, g or o', () => {
    expect(file(0o750, 'o=g')).toBe('755');
    expect(file(0o640, 'g=u')).toBe('660');
    expect(file(0o604, 'u=o')).toBe('404');
    expect(file(0o700, 'go=u')).toBe('777');
    expect(file(0o741, 'g+o')).toBe('751');
    expect(file(0o777, 'o-g', 0o022)).toBe('770');
    expect(file(0o4750, 'o=u')).toBe('4757');
    expect(file(0o700, '=u', 0o022)).toBe('755');
  });

  it('treats X as execute only for directories or when an execute bit is already set', () => {
    expect(file(0o644, 'a+X')).toBe('644');
    expect(file(0o744, 'a+X')).toBe('755');
    expect(file(0o654, 'a+X')).toBe('755');
    expect(file(0o645, 'a+X')).toBe('755');
    expect(dir(0o644, 'a+X')).toBe('755');
    expect(file(0o644, 'u+X')).toBe('644');
    expect(dir(0o600, 'u+X')).toBe('700');
    expect(file(0o600, 'a=rX')).toBe('444');
    expect(file(0o700, 'a=rX')).toBe('555');
    expect(file(0o755, 'a-x,a+X')).toBe('644');
    expect(file(0o644, 'u+x,go+X')).toBe('755');
  });

  it('sets and clears setuid, setgid and sticky for the classes that own them', () => {
    expect(file(0o755, 'u+s')).toBe('4755');
    expect(file(0o755, 'g+s')).toBe('2755');
    expect(file(0o755, 'o+s')).toBe('755');
    expect(file(0o755, 'a+s')).toBe('6755');
    expect(file(0o755, '+s')).toBe('6755');
    expect(file(0o6755, 'u-s')).toBe('2755');
    expect(file(0o6755, 'g-s')).toBe('4755');
    expect(file(0o777, '+t')).toBe('1777');
    expect(file(0o777, 'o+t')).toBe('1777');
    expect(file(0o777, 'a+t')).toBe('1777');
    expect(file(0o777, 'u+t')).toBe('777');
    expect(file(0o777, 'g+t')).toBe('777');
    expect(file(0o1777, 'a-t')).toBe('777');
    expect(file(0o7777, 'a=rwx')).toBe('777');
    expect(file(0o7777, 'u=rwx')).toBe('3777');
    expect(file(0o7777, 'o=rx')).toBe('6775');
  });

  it('keeps setuid and setgid on a directory unless the clause names them', () => {
    expect(dir(0o6755, 'a=rx')).toBe('6555');
    expect(file(0o6755, 'a=rx')).toBe('555');
    expect(dir(0o6755, 'u=rwx,g=rx')).toBe('6755');
    expect(dir(0o6755, 'g=rxs')).toBe('6755');
    expect(dir(0o6755, 'g-s')).toBe('4755');
    expect(dir(0o6755, 'ug-s')).toBe('755');
    expect(dir(0o6755, 'a=')).toBe('6000');
    expect(dir(0o6755, '=')).toBe('6000');
    expect(dir(0o1777, 'a=rwx')).toBe('777');
  });

  it('accepts empty permission lists', () => {
    expect(file(0o755, 'u+')).toBe('755');
    expect(file(0o755, 'g-')).toBe('755');
    expect(file(0o755, '+')).toBe('755');
    expect(file(0o755, 'u+,g-,o=')).toBe('750');
  });

  it('refuses malformed expressions with the position', () => {
    const bad = (expr: string) => applySymbolic(0o644, expr, { directory: false, umask: 0o022 });
    expect(code(bad(''))).toBe('empty');
    expect(code(bad('  '))).toBe('empty');
    expect(code(bad('u'))).toBe('clause-operator');
    expect(code(bad('u+x,g'))).toBe('clause-operator');
    expect(offset(bad('u+x,g'))).toBe(5);
    expect(code(bad('u+x,'))).toBe('clause-empty');
    expect(code(bad(',u+x'))).toBe('clause-empty');
    expect(code(bad('u+x,,g+w'))).toBe('clause-empty');
    expect(offset(bad('u+x,,g+w'))).toBe(4);
    expect(code(bad('x'))).toBe('clause-char');
    expect(code(bad('z+x'))).toBe('clause-char');
    expect(code(bad('u+q'))).toBe('clause-char');
    expect(offset(bad(' u+q'))).toBe(3);
    expect(code(bad('u+x g+w'))).toBe('clause-char');
    expect(code(bad('u=gr'))).toBe('clause-char');
    expect(code(bad('u=rg'))).toBe('clause-char');
    expect(code(bad('755'))).toBe('clause-char');
    expect(code(bad('u+R'))).toBe('clause-char');
    expect(code(bad(`u+${'r'.repeat(CHMOD_LIMITS.symbolicChars - 2)}`))).toBe('ok');
    expect(code(bad(`u+${'r'.repeat(CHMOD_LIMITS.symbolicChars - 1)}`))).toBe('too-long');
  });

  it('ignores bits above the twelve mode bits in the starting mode', () => {
    expect(file(0o100644, 'u+x')).toBe('744');
  });
});

describe('numeric changes', () => {
  it('replace every bit on a file', () => {
    expect(oct(value(applyNumeric(0o6777, '755', false)))).toBe('755');
    expect(oct(value(applyNumeric(0o6777, '0', false)))).toBe('0');
    expect(oct(value(applyNumeric(0o644, '2755', false)))).toBe('2755');
  });

  it('keep setuid and setgid on a directory up to four digits, and clear them with five', () => {
    expect(oct(value(applyNumeric(0o6777, '755', true)))).toBe('6755');
    expect(oct(value(applyNumeric(0o6777, '0755', true)))).toBe('6755');
    expect(oct(value(applyNumeric(0o6777, '00755', true)))).toBe('755');
    expect(oct(value(applyNumeric(0o2755, '644', true)))).toBe('2644');
    expect(oct(value(applyNumeric(0o1777, '755', true)))).toBe('755');
    expect(oct(value(applyNumeric(0o755, '2755', true)))).toBe('2755');
    expect(oct(value(applyNumeric(0o4755, '2755', true)))).toBe('6755');
    expect(oct(value(applyNumeric(0o4755, '02755', true)))).toBe('2755');
  });

  it('refuse empty input, other digits and values above 7777', () => {
    expect(code(applyNumeric(0, '', false))).toBe('empty');
    expect(code(applyNumeric(0, '79', false))).toBe('octal-digits');
    expect(code(applyNumeric(0, 'u+x', false))).toBe('octal-digits');
    expect(code(applyNumeric(0, '10000', false))).toBe('octal-length');
    expect(code(applyNumeric(0, '7777', false))).toBe('ok');
    expect(code(applyNumeric(0, '007777', false))).toBe('ok');
    expect(code(applyNumeric(0, '0000000000000', false))).toBe('octal-length');
  });
});

describe('commands and quoting', () => {
  it('leaves plain paths alone and single-quotes everything else', () => {
    expect(value(shellQuote('/srv/www/index.html'))).toBe('/srv/www/index.html');
    expect(value(shellQuote('file_1.txt'))).toBe('file_1.txt');
    expect(value(shellQuote('my file'))).toBe("'my file'");
    expect(value(shellQuote("it's"))).toBe("'it'\\''s'");
    expect(value(shellQuote("''"))).toBe("''\\'''\\'''");
    expect(value(shellQuote('$(rm -rf ~)'))).toBe("'$(rm -rf ~)'");
    expect(value(shellQuote('$HOME'))).toBe("'$HOME'");
    expect(value(shellQuote('$(id)'))).toBe("'$(id)'");
    expect(value(shellQuote('a;b'))).toBe("'a;b'");
    expect(value(shellQuote('a`b`'))).toBe("'a`b`'");
    expect(value(shellQuote('*.txt'))).toBe("'*.txt'");
    expect(value(shellQuote('~/x'))).toBe("'~/x'");
    expect(value(shellQuote('a\\b'))).toBe("'a\\b'");
    expect(value(shellQuote('a"b'))).toBe("'a\"b'");
    expect(value(shellQuote('a&b|c>d<e'))).toBe("'a&b|c>d<e'");
    expect(value(shellQuote('#x'))).toBe("'#x'");
    expect(value(shellQuote('a=b'))).toBe("'a=b'");
    expect(value(shellQuote('caf' + String.fromCharCode(0xe9)))).toBe(`'caf${String.fromCharCode(0xe9)}'`);
    expect(value(shellQuote(''))).toBe("''");
  });

  it('refuses control characters, line breaks and overlong paths', () => {
    for (const c of [0, 9, 10, 13, 27, 31, 127, 0x85, 0x2028, 0x2029]) {
      const r = shellQuote(`a${String.fromCharCode(c)}b`);
      expect(code(r), `U+${c.toString(16)}`).toBe('path-control');
      expect(offset(r)).toBe(1);
    }
    expect(code(shellQuote(' '))).toBe('ok');
    expect(code(shellQuote('a'.repeat(CHMOD_LIMITS.pathChars)))).toBe('ok');
    expect(code(shellQuote('a'.repeat(CHMOD_LIMITS.pathChars + 1)))).toBe('path-too-long');
  });

  it('builds octal and symbolic commands, with a placeholder when there is no path', () => {
    expect(value(chmodCommands(0o755, ''))).toEqual({ octal: `chmod 0755 ${PATH_PLACEHOLDER}`, symbolic: `chmod u=rwx,g=rx,o=rx ${PATH_PLACEHOLDER}`, template: true });
    expect(PATH_PLACEHOLDER).toBe('<PATH>');
    expect(value(chmodCommands(0o2775, '/srv/shared'))).toEqual({ octal: 'chmod 2775 /srv/shared', symbolic: 'chmod u=rwx,g=rwxs,o=rx /srv/shared', template: false });
    expect(value(chmodCommands(0o600, "John's key")).octal).toBe("chmod 0600 'John'\\''s key'");
  });

  it('guards a path that starts with a dash', () => {
    expect(value(chmodCommands(0o644, '-rf')).octal).toBe('chmod 0644 -- -rf');
    expect(value(chmodCommands(0o644, '-rf')).symbolic).toBe('chmod u=rw,g=r,o=r -- -rf');
    expect(value(chmodCommands(0o644, '--help me')).octal).toBe("chmod 0644 -- '--help me'");
    expect(value(chmodCommands(0o644, 'a-b')).octal).toBe('chmod 0644 a-b');
    expect(code(chmodCommands(0o644, 'a\nb'))).toBe('path-control');
    expect(value(chmodCommands(0o755, '/srv', true))).toEqual({ octal: 'chmod 0755 /srv', symbolic: 'chmod u=rwx,g=rx,o=rx,ug-s /srv', template: false });
  });
});

describe('explanations and warnings', () => {
  it('explains twelve bits, differently for files and directories', () => {
    const f = explainMode(0o4755, false);
    const d = explainMode(0o3755, true);
    expect(f).toHaveLength(12);
    expect(d).toHaveLength(12);
    expect(f.map(e => e.set)).toEqual([true, true, true, true, false, true, true, false, true, true, false, false]);
    expect(d.map(e => e.set)).toEqual([true, true, true, true, false, true, true, false, true, false, true, true]);
    expect(f.map(e => e.label)).toEqual(['Owner read', 'Owner write', 'Owner execute', 'Group read', 'Group write', 'Group execute', 'Others read', 'Others write', 'Others execute', 'setuid', 'setgid', 'sticky']);
    expect(f[2].meaning).toContain('run the file');
    expect(d[2].meaning).toContain('enter the directory');
    expect(f[4].meaning).toContain('cannot change');
    expect(d[0].meaning).toContain('list the names');
    expect(f[9].meaning).toContain("rights of the file's owner");
    expect(explainMode(0o4755, true)[9].meaning).toContain('ignores setuid on a directory');
    expect(d[10].meaning).toContain("take the directory's group");
    expect(d[11].meaning).toContain('rename or delete');
    expect(explainMode(0o1644, false)[11].meaning).toContain('ignores the sticky bit');
  });

  const codes = (mode: number, directory: boolean) => modeWarnings(mode, directory).map(w => w.code).sort();

  it('raises no warning for ordinary modes', () => {
    for (const m of [0o644, 0o755, 0o600, 0o700, 0o640, 0o750, 0o444, 0o4755, 0o2755]) expect(codes(m, false), oct(m)).toEqual([]);
    for (const m of [0o755, 0o700, 0o750, 0o2775, 0o1777, 0o3777]) expect(codes(m, true), oct(m)).toEqual([]);
  });

  it('warns about open, empty and world-writable modes', () => {
    expect(codes(0o777, false)).toEqual(['all-open']);
    expect(codes(0o777, true)).toEqual(['all-open']);
    expect(codes(0o1777, true)).toEqual([]);
    expect(codes(0, false)).toEqual(['no-access']);
    expect(codes(0, true)).toEqual(['no-access']);
    expect(codes(0o666, false)).toEqual(['world-writable']);
    expect(codes(0o646, false)).toContain('world-writable');
    expect(codes(0o773, true)).toEqual(['world-writable-no-sticky']);
    expect(codes(0o1773, true)).toEqual([]);
    expect(codes(0o664, false)).toEqual([]);
  });

  it('warns about writable setuid and setgid programs and special bits without execute', () => {
    expect(codes(0o4775, false)).toEqual(['setuid-writable']);
    expect(codes(0o4757, false)).toEqual(['setuid-writable', 'world-writable']);
    expect(codes(0o4755, false)).toEqual([]);
    expect(codes(0o2757, false)).toEqual(['setgid-writable', 'world-writable']);
    expect(codes(0o2775, false)).toEqual([]);
    expect(codes(0o4644, false)).toEqual(['special-no-exec']);
    expect(codes(0o2744, false)).toEqual(['special-no-exec']);
    expect(codes(0o2754, false)).toEqual([]);
    expect(codes(0o1776, true)).toEqual(['special-no-exec', 'write-no-exec-dir']);
    expect(codes(0o4775, true)).toEqual([]);
  });

  it('warns when the owner is locked out or has less than the others', () => {
    expect(codes(0o077, false)).toContain('owner-locked-out');
    expect(codes(0o044, false)).toEqual(['owner-locked-out']);
    expect(codes(0o400, false)).toEqual([]);
    expect(codes(0o467, false)).toEqual(['group-more-than-owner', 'world-writable']);
    expect(codes(0o575, false)).toEqual(['group-more-than-owner']);
    expect(codes(0o557, false)).toContain('group-more-than-owner');
    expect(codes(0o754, false)).toEqual([]);
  });

  it('warns about write without execute on a directory, once', () => {
    expect(codes(0o600, true)).toEqual(['write-no-exec-dir']);
    expect(codes(0o660, true)).toEqual(['write-no-exec-dir']);
    expect(codes(0o760, true)).toEqual(['write-no-exec-dir']);
    expect(codes(0o600, false)).toEqual([]);
  });
});
