// Mutation check for the unit suite: each mutation breaks one rule or threshold in the engine, and
// at least one test must then fail. A mutation that survives means the rule is not really tested.
// Works on a scratch copy of the repository, so the working tree is never modified.
//
//   node scripts/mutations.mjs            run every mutation
//   node scripts/mutations.mjs json       only mutations whose label contains "json"

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** [label, file, exact text to replace, replacement] */
const MUTATIONS = [
  // IPv4
  ['ipv4: /31 treated as standard', 'src/core/net/ipv4.ts', 'if (prefix === 31) {', 'if (prefix === 30) {'],
  ['ipv4: usable hosts off by one', 'src/core/net/ipv4.ts', 'usableHosts: totalAddresses - 2n', 'usableHosts: totalAddresses - 1n'],
  ['ipv4: first usable is the network address', 'src/core/net/ipv4.ts', 'firstUsable: network + 1n', 'firstUsable: network'],
  ['ipv4: leading zeros accepted', 'src/core/net/ipv4.ts', "if (part.length > 1 && part.startsWith('0')) {", "if (part.length > 2 && part.startsWith('0')) {"],
  ['ipv4: octet 256 accepted', 'src/core/net/ipv4.ts', 'Number(part) > 255', 'Number(part) > 256'],
  ['ipv4: non-contiguous masks accepted', 'src/core/net/ipv4.ts', 'return prefixToMask(prefix) === mask ? prefix : null;', 'return prefix;'],
  ['ipv4: wildcard masks not recognized', 'src/core/net/ipv4.ts', 'if (inversePrefix !== null) {', 'if (inversePrefix === -1) {'],
  ['ipv4: prefix 33 accepted', 'src/core/net/ipv4.ts', 'Number(suffix) > IPV4_BITS', 'Number(suffix) > IPV4_BITS + 1'],
  ['ipv4: network/broadcast role swapped', 'src/core/net/ipv4.ts', "address === network ? 'network' : address === last ? 'broadcast' : 'host'", "address === network ? 'broadcast' : address === last ? 'network' : 'host'"],
  ['ipv4: mask shift off by one', 'src/core/net/ipv4.ts', '(IPV4_MAX << BigInt(IPV4_BITS - prefix)) & IPV4_MAX', '(IPV4_MAX << BigInt(IPV4_BITS - prefix + 1)) & IPV4_MAX'],
  // JSON
  ['json: trailing comma allowed in arrays', 'src/core/data/json.ts', "if (ch === ']' && this.state === 'first-value-or-close') return this.close();", "if (ch === ']') return this.close();"],
  ['json: unsafe integer threshold moved', 'src/core/data/json.ts', 'if (magnitude > MAX_SAFE) {', 'if (magnitude > MAX_SAFE + 1n) {'],
  ['json: long-integer check skipped below 17 digits', 'src/core/data/json.ts', 'if (integer && raw.length >= 16) {', 'if (integer && raw.length >= 17) {'],
  ['json: duplicate names not detected', 'src/core/data/json.ts', 'if (top.keys!.has(name)) {', 'if (top.keys!.has(name + "x")) {'],
  ['json: empty containers broken over lines', 'src/core/data/json.ts', 'if (frame.count > 0) this.newline(this.stack.length);', 'this.newline(this.stack.length);'],
  ['json: no space after colon', 'src/core/data/json.ts', "this.emit(this.pretty ? ': ' : ':');", "this.emit(':');"],
  ['json: leading zeros allowed', 'src/core/data/json.ts', "if (isDigit(next)) throw new Failure('leading-zero'", "if (next === -1) throw new Failure('leading-zero'"],
  ['json: any \\u escape accepted', 'src/core/data/json.ts', 'if (!isHex(text.charCodeAt(i + k)))', 'if (false && !isHex(text.charCodeAt(i + k)))'],
  ['json: control character 0x1f allowed', 'src/core/data/json.ts', 'if (c < 0x20) {', 'if (c < 0x1f) {'],
  ['json: byte order mark not skipped', 'src/core/data/json.ts', 'if (text.charCodeAt(0) === 0xfeff) {', 'if (text.charCodeAt(0) === 0xfffe) {'],
  ['json: lone CR not a line break', 'src/core/text.ts', 'else if (code === 0x0d) {', 'else if (code === 0x0d && false) {'],
  ['time: ISO sub-millisecond warning missed', 'src/core/time/timestamp.ts', "if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) warnings.push(SUBMS_WARNING);\n  const wall", "if (fraction.length > 4 && /[1-9]/.test(fraction.slice(3))) warnings.push(SUBMS_WARNING);\n  const wall"],
  ['json: surrogate pairs counted as two columns', 'src/core/text.ts', 'if (next >= 0xdc00 && next <= 0xdfff) i++;', 'if (next >= 0xdc00 && next <= 0xdfff) i += 0;'],
  ['json: output limit off by one', 'src/core/data/json.ts', 'if (this.outChars > this.maxOutput) {', 'if (this.outChars >= this.maxOutput) {'],
  // Timestamps
  ['time: Auto threshold lowered', 'src/core/time/timestamp.ts', 'export const AUTO_MS_THRESHOLD = 100_000_000_000n;', 'export const AUTO_MS_THRESHOLD = 10_000_000_000n;'],
  ['time: Auto threshold inclusive the other way', 'src/core/time/timestamp.ts', "BigInt(numeric[2]) >= AUTO_MS_THRESHOLD ? 'milliseconds'", "BigInt(numeric[2]) > AUTO_MS_THRESHOLD ? 'milliseconds'"],
  ['time: maximum one millisecond too high', 'src/core/time/timestamp.ts', 'export const MAX_EPOCH_MS = 253_402_300_799_999;', 'export const MAX_EPOCH_MS = 253_402_300_800_000;'],
  ['time: minimum one millisecond too low', 'src/core/time/timestamp.ts', 'export const MIN_EPOCH_MS = -62_135_596_800_000;', 'export const MIN_EPOCH_MS = -62_135_596_800_001;'],
  ['time: century leap rule dropped', 'src/core/time/timestamp.ts', '(year % 4 === 0 && year % 100 !== 0) || year % 400 === 0', 'year % 4 === 0'],
  ['time: 24:00 accepted', 'src/core/time/timestamp.ts', "if (hour === 24) return fail('hour-24'", "if (hour === 25) return fail('hour-24'"],
  ['time: leap second accepted', 'src/core/time/timestamp.ts', "if (second === 60) return fail('leap-second'", "if (second === 61) return fail('leap-second'"],
  ['time: sub-millisecond warning missed', 'src/core/time/timestamp.ts', "if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) warnings.push(SUBMS_WARNING);\n  } else {", "if (fraction.length > 4 && /[1-9]/.test(fraction.slice(3))) warnings.push(SUBMS_WARNING);\n  } else {"],
  ['time: seconds lose their fraction', 'src/core/time/timestamp.ts', "ms = whole * 1000n + BigInt(fraction.slice(0, 3).padEnd(3, '0'));", 'ms = whole * 1000n;'],
  ['time: Unix seconds keep trailing zeros', 'src/core/time/timestamp.ts', ".padStart(3, '0').replace(/0+$/, '');", ".padStart(3, '0');"],
  ['zones: candidate instants not verified', 'src/core/time/zones.ts', '.filter(t => offsetAt(t, zone) === asUtc - t)', '.filter(t => Number.isFinite(t))'],
  ['zones: years 0 to 99 read as 1900s', 'src/core/time/zones.ts', 'd.setUTCFullYear(w.year, w.month - 1, w.day);', 'd.setTime(Date.UTC(w.year, w.month - 1, w.day));'],
  ['zones: BC years off by one', 'src/core/time/zones.ts', 'if (bc) year = 1 - year;', 'if (bc) year = -year;'],
  ['zones: transition search stops early', 'src/core/time/zones.ts', 'while (hi - lo > 1) {', 'while (hi - lo > 1000) {'],
  ['zones: Kolkata shown as Calcutta', 'src/core/time/zones.ts', "'Asia/Calcutta': 'Asia/Kolkata',", ''],
  ['zones: offset seconds hidden', 'src/core/time/zones.ts', 'return s === 0 ? base : `${base}:${String(s).padStart(2, \'0\')}`;', 'return base;'],
  // App infrastructure
  ['prefs: any theme accepted', 'src/app/prefs.ts', "valid: (v: string) => v === 'dark' || v === 'light'", 'valid: (v: string) => v.length > 0'],
  ['prefs: unknown keys accepted', 'src/app/prefs.ts', 'if (!Object.prototype.hasOwnProperty.call(PREF_SCHEMA, key)) throw', 'if (false) throw'],
  ['prefs: clear removes other apps\' keys', 'src/app/prefs.ts', 'if (k !== null && k.startsWith(PREF_PREFIX)) keys.push(k);', 'if (k !== null) keys.push(k);'],
  ['registry: duplicate ids accepted', 'src/app/registry.ts', 'if (this.byId.has(tool.id)) throw', 'if (false) throw'],
  ['search: name matches no longer outrank keywords', 'src/app/search.ts', 'if (words(name).some(w => w === term)) return 100;', 'if (words(name).some(w => w === term)) return 1;'],
  ['router: ids not lowercased', 'src/app/router.ts', 'id = decodeURIComponent(path).toLowerCase();', 'id = decodeURIComponent(path);'],
  ['csv: formula guard off by default', 'src/core/export/csv.ts', 'if ((options.guardFormulas ?? true)', 'if ((options.guardFormulas ?? false)'],
  ['files: Windows device names allowed', 'src/core/export/files.ts', 'let result = RESERVED_WINDOWS.test(stem) ?', 'let result = false ?'],
];

function run(cwd, args) {
  return spawnSync(process.execPath, [join(cwd, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...args], { cwd, encoding: 'utf8' });
}

const filter = process.argv[2];
const selected = MUTATIONS.filter(([label]) => !filter || label.includes(filter));
const work = mkdtempSync(join(tmpdir(), 'netforge-mutations-'));
try {
  for (const entry of ['src', 'tests', 'scripts', 'public', 'package.json', 'tsconfig.json', 'vite.config.ts', 'index.html', '.gitignore', '.gitattributes', 'README.md', 'CHANGELOG.md']) {
    cpSync(join(ROOT, entry), join(work, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'junction');
  // The house test asks git which files are publishable; give the copy its own repository.
  execFileSync('git', ['init', '-q'], { cwd: work });
  execFileSync('git', ['add', '-A'], { cwd: work });

  const baseline = run(work, []);
  if (baseline.status !== 0) {
    console.error('Baseline run failed; mutation results would be meaningless.\n', baseline.stdout.slice(-2000));
    process.exit(2);
  }
  console.log(`Baseline passes. Running ${selected.length} mutations.`);
  const survivors = [];
  for (const [label, file, from, to] of selected) {
    const path = join(work, file);
    const original = readFileSync(path, 'utf8');
    const count = original.split(from).length - 1;
    if (count !== 1) {
      console.error(`SETUP ERROR ${label}: expected the text once in ${file}, found ${count} times`);
      survivors.push(`${label} (setup error)`);
      continue;
    }
    writeFileSync(path, original.replace(from, to));
    const result = run(work, ['--bail', '1']);
    writeFileSync(path, original);
    const killed = result.status !== 0;
    console.log(`${killed ? 'killed  ' : 'SURVIVED'} ${label}`);
    if (!killed) survivors.push(label);
  }
  console.log(`\n${selected.length - survivors.length} of ${selected.length} mutations killed.`);
  if (survivors.length) {
    console.log(`Survivors:\n  ${survivors.join('\n  ')}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
