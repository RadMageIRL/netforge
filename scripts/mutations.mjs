// Mutation check for the unit suite: each mutation breaks one rule or threshold in the engine, and
// at least one test must then fail. A mutation that survives means the rule is not really tested.
// Works on a scratch copy of the repository, so the working tree is never modified.
//
//   node scripts/mutations.mjs            run every mutation
//   node scripts/mutations.mjs json       only mutations whose label contains "json"
//
// Later mutations live in scripts/mutations-phase4.json and scripts/mutations-phase5-*.json. Each
// group names the test files that cover its module, and only those are run for it, which keeps
// several hundred mutations practical.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  // Phase 1: IPv6 text
  ['ipv6: tie goes to the last zero run', 'src/core/net/ipv6.ts', 'if (j - i > bestLength) {', 'if (j - i >= bestLength) {'],
  ['ipv6: single zero group compressed', 'src/core/net/ipv6.ts', 'let bestLength = 1;', 'let bestLength = 0;'],
  ['ipv6: IPv4-mapped not in mixed notation', 'src/core/net/ipv6.ts', 'if (isIPv4Mapped(value)) return', 'if (false && isIPv4Mapped(value)) return'],
  ['ipv6: uppercase output', 'src/core/net/ipv6.ts', 'const hex = groups.map(g => g.toString(16));', 'const hex = groups.map(g => g.toString(16).toUpperCase());'],
  ['ipv6: "::" allowed twice', 'src/core/net/ipv6.ts', 'if (halves.length > 2)', 'if (halves.length > 3)'],
  ['ipv6: eight groups beside "::"', 'src/core/net/ipv6.ts', 'if (head.length + tail.length > 7)', 'if (head.length + tail.length > 8)'],
  ['ipv6: five-digit groups accepted', 'src/core/net/ipv6.ts', 'const HEX = /^[0-9a-fA-F]{1,4}$/;', 'const HEX = /^[0-9a-fA-F]{1,5}$/;'],
  ['ipv6: prefix /129 accepted', 'src/core/net/address.ts', 'Number(suffix) > 128', 'Number(suffix) > 129'],
  // Phase 1: set operations
  ['ops: mixed families accepted', 'src/core/net/address.ts', 'for (const item of items) if (item.family !== family) throw new FamilyMismatchError(operation);', 'for (const item of items) if (item.family !== family && false) throw new FamilyMismatchError(operation);'],
  ['ops: adjacent ranges not merged', 'src/core/net/ops.ts', 'if (top && r.first <= top.last + 1n) {', 'if (top && r.first <= top.last) {'],
  ['ops: range to CIDR ignores alignment', 'src/core/net/ops.ts', 'let size = trailingZeros(first, bits);', 'let size = bits;'],
  ['ops: containment misses shared start', 'src/core/net/ops.ts', 'return outer.first <= inner.first && inner.last <= outer.last;', 'return outer.first < inner.first && inner.last <= outer.last;'],
  ['ops: overlap misses touching ranges', 'src/core/net/ops.ts', 'return a.first <= b.last && b.first <= a.last;', 'return a.first < b.last && b.first < a.last;'],
  ['ops: split skips the first subnet', 'src/core/net/ops.ts', 'for (let i = offset; i < total && subnets.length < limit; i++) {', 'for (let i = offset + 1n; i < total && subnets.length < limit; i++) {'],
  ['ops: supernet keeps host bits', 'src/core/net/ops.ts', 'return makePrefix(prefix.family, prefix.network, newLength);', 'return { family: prefix.family, network: prefix.network, length: newLength };'],
  ['ops: covering prefix one bit too long', 'src/core/net/ops.ts', 'return makePrefix(family, first, bits - differing);', 'return makePrefix(family, first, Math.min(bits, bits - differing + 1));'],
  ['ops: gap keeps the removed edge', 'src/core/net/ops.ts', 'if (r.first > cursor) out.push({ family: base.family, first: cursor, last: r.first - 1n });', 'if (r.first > cursor) out.push({ family: base.family, first: cursor, last: r.first });'],
  ['list: reversed range accepted', 'src/core/net/list.ts', 'if (last.value.value < first.value.value) return {', 'if (false) return {'],
  // Phase 1: classification
  ['classify: least specific block decides', 'src/core/net/classify.ts', '.sort((a, b) => b.prefix.length - a.prefix.length);', '.sort((a, b) => a.prefix.length - b.prefix.length);'],
  ['classify: blank (deprecated) rows decide', 'src/core/net/classify.ts', "const decider = matches.find(m => m.globallyReachable !== 'unspecified') ?? null;", 'const decider = matches[0] ?? null;'],
  ['classify: last address of a block excluded', 'src/core/net/classify.ts', '.filter(b => b.family === family && b.range.first <= value && value <= b.range.last)', '.filter(b => b.family === family && b.range.first <= value && value < b.range.last)'],
  ['classify: multicast scope read from the wrong nibble', 'src/core/net/classify.ts', 'const scope = Number((value >> 112n) & 0xfn);', 'const scope = Number((value >> 116n) & 0xfn);'],
  ['registry: data edited by hand', 'src/core/net/registry-data.ts', '"block":"198.18.0.0/15","name":"Benchmarking"', '"block":"198.18.0.0/15","name":"Benchmark"'],
  // Phase 1: VLSM
  ['vlsm: smallest block first', 'src/core/net/vlsm.ts', 'a.length - b.length || b.hosts - a.hosts || a.index - b.index', 'b.length - a.length || b.hosts - a.hosts || a.index - b.index'],
  ['vlsm: equal requests in reverse order', 'src/core/net/vlsm.ts', 'a.length - b.length || b.hosts - a.hosts || a.index - b.index', 'a.length - b.length || b.hosts - a.hosts || b.index - a.index'],
  ['vlsm: host count tie-break ignored', 'src/core/net/vlsm.ts', 'a.length - b.length || b.hosts - a.hosts || a.index - b.index', 'a.length - b.length || a.index - b.index'],
  ['vlsm: /31 without the option', 'src/core/net/vlsm.ts', 'if (pointToPoint && hosts === 2) return 31;', 'if (hosts === 2) return 31;'],
  ['vlsm: capacity keeps network and broadcast', 'src/core/net/vlsm.ts', 'return prefixSize(4, length) - 2n;', 'return prefixSize(4, length);'],
  ['vlsm: unaligned placement', 'src/core/net/vlsm.ts', 'candidate = alignUp(clash.last + 1n, size);', 'candidate = clash.last + 1n;'],
  ['vlsm: clash check misses a shared edge', 'src/core/net/vlsm.ts', 'const clash = k < occupied.length && occupied[k].first <= end ? occupied[k] : null;', 'const clash = k < occupied.length && occupied[k].first < end ? occupied[k] : null;'],
  ['vlsm: clash scan skips a block ending at the candidate', 'src/core/net/vlsm.ts', 'while (k < occupied.length && occupied[k].last < candidate) k++;', 'while (k < occupied.length && occupied[k].last <= candidate) k++;'],
  ['vlsm: fixed allocation may overlap a reservation', 'src/core/net/vlsm.ts', 'const clashReserved = reservations.find(o => rangesOverlap(o.range, range));', 'const clashReserved = reservations.find(() => false);'],
  ['vlsm: names compared case-sensitively', 'src/core/net/vlsm.ts', 'const key = name.toLowerCase();', 'const key = name;'],
  ['vlsm: request larger than parent attempted', 'src/core/net/vlsm.ts', 'if (req.length < parent.length) {', 'if (req.length < parent.length - 1) {'],
  // Phase 1: analysis and exports
  ['analysis: containment reported as overlap', 'src/core/net/analysis.ts', "b.last <= a.last ? 'contains' : 'overlap'", "'overlap'"],
  ['analysis: parent gaps ignore the entries', 'src/core/net/analysis.ts', 'const gapRanges = subtractRanges(pr, overlapping);', 'const gapRanges = subtractRanges(pr, []);'],
  ['routes: supernet offered for a single route', 'src/core/net/analysis.ts', 'if (routes.length > 1) {', 'if (routes.length > 0) {'],
  ['routes: duplicates not counted', 'src/core/net/analysis.ts', 'if (keys.has(key)) duplicates++;', 'if (keys.has(key)) duplicates += 0;'],
  ['reports: CSV leaves out free space', 'src/core/net/reports.ts', 'for (const p of result.free) rows.push(', 'for (const p of result.free.slice(0, 0)) rows.push('],
  // Phase 2: plan validation
  ['plan: VLAN IDs unique per site instead of per namespace', 'src/core/plan/validate.ts', 'if (ns && vlanNumber !== null) push(byNamespaceId, ns.id, { vlan: v, n: vlanNumber });', 'if (ns && vlanNumber !== null) push(byNamespaceId, v.siteId, { vlan: v, n: vlanNumber });'],
  ['plan: a VRF boundary makes VLAN IDs unique', 'src/core/plan/validate.ts', 'if (ns && vlanNumber !== null) push(byNamespaceId, ns.id, { vlan: v, n: vlanNumber });', 'if (ns && vlanNumber !== null) push(byNamespaceId, `${ns.id}|${v.vrfId}`, { vlan: v, n: vlanNumber });'],
  ['plan: VLAN 4095 accepted', 'src/core/plan/validate.ts', 'if (n === 0 || n === 4095)', 'if (n === 0)'],
  ['plan: namespace of another site accepted', 'src/core/plan/validate.ts', "else if (site && ns.siteId !== '' && ns.siteId !== v.siteId)", 'else if (false)'],
  ['plan: reuse across independent VRFs is an error', 'src/core/plan/validate.ts', "if (scope.kind === 'independent-vrfs') {", 'if (false) {'],
  ['plan: route exchange ignored', 'src/core/plan/validate.ts', 'if (exchanging.has(`${a}|${b}`)) return', 'if (false) return'],
  ['plan: route exchange counted one way only', 'src/core/plan/validate.ts', 'exchanging.add(`${other}|${v.id}`);', ''],
  ['plan: touching networks reported as overlapping', 'src/core/plan/validate.ts', 'a.range.family === item.range.family && a.range.last >= item.range.first', 'a.range.family === item.range.family && a.range.last + 1n >= item.range.first'],
  ['plan: identical networks not called duplicates', 'src/core/plan/validate.ts', "add('error', same ? 'duplicate-network' : 'overlap'", "add('error', 'overlap'"],
  ['plan: gateway may be the broadcast address', 'src/core/plan/validate.ts', 'else if (standard4 && gw4 === net4Range.last)', 'else if (false)'],
  ['plan: /31 treated as having network and broadcast addresses', 'src/core/plan/validate.ts', 'const standard4 = net4 !== null && net4.length <= 30;', 'const standard4 = net4 !== null && net4.length <= 31;'],
  ['plan: DHCP pool may include the gateway', 'src/core/plan/validate.ts', 'if (gw4 !== null && r.first <= gw4 && gw4 <= r.last)', 'if (false)'],
  ['plan: DHCP pool may overlap a reservation', 'src/core/plan/validate.ts', "if (overlaps(res.range, r)) add('error', 'dhcp-reserved'", "if (false) add('error', 'dhcp-reserved'"],
  ['plan: DHCP pool may include the broadcast address', 'src/core/plan/validate.ts', 'if (standard4 && r.last === net4Range.last) {', 'if (false) {'],
  ['plan: DHCP pools may overlap each other', 'src/core/plan/validate.ts', "if (clash) add('error', 'dhcp-overlap'", "if (false) add('error', 'dhcp-overlap'"],
  ['plan: capacity check off by one', 'src/core/plan/validate.ts', 'if (capacity < BigInt(hosts)) {', 'if (capacity + 1n < BigInt(hosts)) {'],
  ['plan: parent blocks ignored', 'src/core/plan/validate.ts', 'if (!blocks || blocks.some(b => inside(b.range, item.range))) continue;', 'continue;'],
  ['plan: Subnet-Router anycast gateway accepted', 'src/core/plan/validate.ts', 'else if (gw === home.range.first && home.prefix.length < 127)', 'else if (false)'],
  ['plan: link-local IPv6 gateway rejected', 'src/core/plan/validate.ts', 'if (!linkLocal) {', 'if (true) {'],
  ['plan: IPv6 LAN prefixes longer than /64 not flagged', 'src/core/plan/validate.ts', 'if (prefix.length !== 64) {', 'if (prefix.length < 64) {'],
  ['plan: blocks in independent VRFs reported as overlapping', 'src/core/plan/validate.ts', "if (scope.kind === 'independent-vrfs') return;", 'if (false) return;'],
  // Phase 2: allocation
  ['prefix-alloc: unaligned children', 'src/core/net/prefix-alloc.ts', 'next = alignUp(freeRanges[rangeIndex].first, size);', 'next = freeRanges[rangeIndex].first;'],
  ['prefix-alloc: free count off by one', 'src/core/net/prefix-alloc.ts', 'return (range.last - start + 1n) / size;', 'return (range.last - start) / size;'],
  ['prefix-alloc: run limit not enforced', 'src/core/net/prefix-alloc.ts', 'if (requested > maxChildren) {', 'if (requested > maxChildren * 2) {'],
  ['prefix-alloc: requests not atomic', 'src/core/net/prefix-alloc.ts', 'if (need > available) {', 'if (need > available + 1n) {'],
  ['allocate: fixed networks reassigned', 'src/core/plan/allocate.ts', 'const wantsNew = !hasText || (options.reallocate && !v.ipv4.fixed);', 'const wantsNew = !hasText || options.reallocate;'],
  ['allocate: replaces networks without confirmation', 'src/core/plan/allocate.ts', 'if (preview.overwrites > 0 && !confirmOverwrite) {', 'if (false) {'],
  ['allocate: stale preview applied', 'src/core/plan/allocate.ts', 'if (!v || !current || current.join(', 'if (!v || !current || false && current.join('],
  ['allocate: networks of other VRFs treated as used', 'src/core/plan/allocate.ts', '    if (!vrfIds.has(v.vrfId) || replacing.has(v.id)) continue;\n    const p = validation.parsed.get(v.id)?.ipv4;', '    if (replacing.has(v.id)) continue;\n    const p = validation.parsed.get(v.id)?.ipv4;'],
  ['allocate: other sites\' blocks handed out', 'src/core/plan/allocate.ts', 'if (site.id !== siteId) {', 'if (false) {'],
  ['allocate: block reservations ignored', 'src/core/plan/allocate.ts', 'if (range) out.push(range);', ''],
  ['allocate: later parents never tried', 'src/core/plan/allocate.ts', 'remaining = remaining.filter(r => failed.has(r.label));', 'remaining = [];'],
  // Phase 2: file and map
  ['plan file: newer version accepted', 'src/core/plan/file.ts', 'if (version > PLAN_VERSION) return fail(', 'if (version > PLAN_VERSION + 1) return fail('],
  ['plan file: duplicate JSON names accepted', 'src/core/plan/file.ts', "if (dup) return fail('duplicate-key'", "if (false) return fail('duplicate-key'"],
  ['plan file: duplicate ids accepted', 'src/core/plan/file.ts', 'if (seen.has(v)) throw', 'if (false) throw'],
  ['plan file: unknown fields kept silently', 'src/core/plan/file.ts', 'if (known.includes(key)) continue;', 'continue;'],
  ['map: conflicts drawn across independent VRFs', 'src/core/plan/addressmap.ts', 'if (a.vrfId !== it.vrfId && !exch.has(', 'if (false && a.vrfId !== it.vrfId && !exch.has('],
  ['map: more than 256 cells per view', 'src/core/plan/addressmap.ts', 'export const MAX_CELL_BITS = 8;', 'export const MAX_CELL_BITS = 9;'],
  // Phase 3: calendar
  ['calendar: century leap rule dropped', 'src/core/schedule/calendar.ts', 'return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;', 'return year % 4 === 0;'],
  ['calendar: November has 31 days', 'src/core/schedule/calendar.ts', 'return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;', 'return month === 4 || month === 6 || month === 9 ? 30 : 31;'],
  ['calendar: W moves Saturday the 1st back into the previous month', 'src/core/schedule/calendar.ts', 'if (dow === 6) return day === 1 ? 3 : day - 1;', 'if (dow === 6) return day - 1;'],
  ['calendar: W moves a Sunday last day into the next month', 'src/core/schedule/calendar.ts', 'if (dow === 0) return day === last ? day - 2 : day + 1;', 'if (dow === 0) return day + 1;'],
  // Phase 3: standard cron
  ['cron: OR rule used when a day field starts with *', 'src/core/schedule/cron.ts', "const dayRule = dom.star || dow.star ? 'and' : 'or';", "const dayRule = dom.star && dow.star ? 'and' : 'or';"],
  ['cron: star flag only for a bare *', 'src/core/schedule/cron.ts', "star: piece.text.startsWith('*')", "star: piece.text === '*'"],
  ['cron: weekday 7 not read as Sunday', 'src/core/schedule/cron.ts', "return spec.key === 'day-of-week' && v === 7 ? 0 : v;", 'return v;'],
  ['cron: weekday 7 out of range', 'src/core/schedule/cron.ts', "{ key: 'day-of-week', label: 'Day of week', min: 0, max: 7, names: DOW_ABBR, nameBase: 0 },", "{ key: 'day-of-week', label: 'Day of week', min: 0, max: 6, names: DOW_ABBR, nameBase: 0 },"],
  ['cron: step 0 accepted', 'src/core/schedule/cron.ts', 'if (step === 0 || stepText.length > 4) return', 'if (stepText.length > 4) return'],
  ['cron: Quartz n/s silently accepted', 'src/core/schedule/cron.ts', "      if (slash >= 0) {\n        return scheduleFail('quartz-syntax'", "      if (false) {\n        return scheduleFail('quartz-syntax'"],
  ['cron: wrapping range accepted', 'src/core/schedule/cron.ts', '    if (a.value > b.value) {\n      return scheduleFail(\'reversed-range\'', '    if (false) {\n      return scheduleFail(\'reversed-range\''],
  ['cron: @weekly on Monday', 'src/core/schedule/cron.ts', "'@weekly': '0 0 * * 0',", "'@weekly': '0 0 * * 1',"],
  ['cron: DST note ignores wildcard hours', 'src/core/schedule/cron.ts', 'const wildcard = s.fields.minute.star || s.fields.hour.star;', 'const wildcard = s.fields.minute.star && s.fields.hour.star;'],
  // Phase 3: Quartz
  ['quartz: both day fields accepted without ?', 'src/core/schedule/quartz.ts', 'if (!domQ && !dowQ) {', 'if (false) {'],
  ['quartz: L-n off by one', 'src/core/schedule/quartz.ts', "else if (sp.kind === 'last') dayMatches = (y, m, d) => d === daysInMonth(y, m) - sp.offset;", "else if (sp.kind === 'last') dayMatches = (y, m, d) => d === daysInMonth(y, m) - sp.offset - 1;"],
  ['quartz: weekdays numbered from 0', 'src/core/schedule/quartz.ts', 'dayMatches = (y, m, d) => dows.has(weekday(y, m, d) + 1);', 'dayMatches = (y, m, d) => dows.has(weekday(y, m, d));'],
  ['quartz: # uses the wrong weekday', 'src/core/schedule/quartz.ts', 'd === nthWeekday(y, m, sp.dow - 1, sp.n);', 'd === nthWeekday(y, m, sp.dow, sp.n);'],
  ['quartz: W accepted for days 29 to 31', 'src/core/schedule/quartz.ts', 'if (n > 28) return scheduleFail(\'unsupported\', `${n}W', 'if (n > 31) return scheduleFail(\'unsupported\', `${n}W'],
  ['quartz: L-28 accepted', 'src/core/schedule/quartz.ts', "if (n >= 28) return scheduleFail('unsupported', `L-${n}", "if (n >= 31) return scheduleFail('unsupported', `L-${n}"],
  ['quartz: wrapping range accepted', 'src/core/schedule/quartz.ts', "  if (a.value > b.value) {\n    return scheduleFail('reversed-range'", "  if (false) {\n    return scheduleFail('reversed-range'"],
  ['quartz: mixed name and number range accepted', 'src/core/schedule/quartz.ts', 'if (isName(baseText.slice(0, dash)) !== isName(baseText.slice(dash + 1))) {', 'if (false) {'],
  ['quartz: year 2100 accepted', 'src/core/schedule/quartz.ts', "{ key: 'year', label: 'Year', min: 1970, max: 2099 },", "{ key: 'year', label: 'Year', min: 1970, max: 2100 },"],
  ['quartz: runs listed past 2099', 'src/core/schedule/quartz.ts', 'export const QUARTZ_LAST_YEAR = 2099;', 'export const QUARTZ_LAST_YEAR = 2199;'],
  // Phase 3: systemd
  ['systemd: weekday ignored when a date is given', 'src/core/schedule/systemd.ts', 'return (wd & (1 << monFirst)) !== 0;', 'return true;'],
  ['systemd: weeks start on Sunday', 'src/core/schedule/systemd.ts', 'const monFirst = (weekday(y, m, d) + 6) % 7;', 'const monFirst = weekday(y, m, d) % 7;'],
  ['systemd: ~ counted one day off', 'src/core/schedule/systemd.ts', 'if (!eom.has(daysInMonth(y, m) - d + 1)) return false;', 'if (!eom.has(daysInMonth(y, m) - d)) return false;'],
  ['systemd: ~29 to ~31 accepted', 'src/core/schedule/systemd.ts', 'const EOM_MAX = 28;', 'const EOM_MAX = 31;'],
  ['systemd: range end not normalized', 'src/core/schedule/systemd.ts', 'if (repeat > 0) stop = start + Math.floor((stop - start) / repeat) * repeat;', ''],
  ['systemd: n/r past the field end accepted', 'src/core/schedule/systemd.ts', ': start + repeat > max) {', ': start + repeat > max + 1) {'],
  ['systemd: year 69 read as 1969', 'src/core/schedule/systemd.ts', 'n = n < 70 ? 2000 + n : 1900 + n;', 'n = n < 69 ? 2000 + n : 1900 + n;'],
  ['systemd: two weekdays written as a range', 'src/core/schedule/systemd.ts', 'if (y - x >= 2) parts.push(', 'if (y - x >= 1) parts.push('],
  ['systemd: repeated hour run twice', 'src/core/schedule/systemd.ts', "  repeatedSecond: 'skipped',", "  repeatedSecond: 'runs',"],
  ['systemd: second pass skipped even when starting inside it', 'src/core/schedule/systemd.ts', "  repeatedSecondFromInside: 'runs',", ''],
  ['systemd: zone case not checked', 'src/core/schedule/systemd.ts', 'if (exact && exact !== t) return', 'if (false) return'],
  ['systemd: cron */n accepted', 'src/core/schedule/systemd.ts', "if (/^\\*\\/[0-9]/.test(t) || t.includes('*/')) return", 'if (false) return'],
  // Phase 3: search and zones
  ['search: rows appended without ordering', 'src/core/schedule/search.ts', 'if (!last || last.key < item.key || (last.key === item.key && last.order <= item.order)) {', 'if (true) {'],
  ['search: rows final before later wall times are seen', 'src/core/schedule/search.ts', 'flush(wallMs - timeline.maxOffsetNear(wallMs));', 'flush(wallMs + 86_400_000);'],
  ['search: wall times start at the UTC start', 'src/core/schedule/search.ts', 'const startWall = fromMs + timeline.minOffsetNear(fromMs);', 'const startWall = fromMs;'],
  ['search: a run at the start instant counted', 'src/core/schedule/search.ts', 'if (m.epochMs > fromMs) insertSorted(', 'if (m.epochMs >= fromMs) insertSorted('],
  ['search: horizon of 4 years', 'src/core/schedule/search.ts', 'export const SEARCH_YEARS = 400;', 'export const SEARCH_YEARS = 4;'],
  ['search: no limit on candidate times', 'src/core/schedule/search.ts', 'if (examined > MAX_WALL_TIMES) break;', ''],
  ['zones: transition instant belongs to the old offset', 'src/core/schedule/zone-timeline.ts', 'if (t >= lo && t < hi) hits.push', 'if (t > lo && t <= hi) hits.push'],
  ['dst: single affected time not reported', 'src/core/schedule/dst.ts', 'if (count > 0) out.push(', 'if (count > 1) out.push('],
  // Phase 3: Windows
  ['windows: week interval ignored', 'src/core/schedule/windows.ts', '&& (weekIndex(n) - firstWeek) % t.weeksInterval === 0;', ';'],
  ['windows: weeks start on Monday', 'src/core/schedule/windows.ts', 'return Math.floor((dayNumber + 4) / 7);', 'return Math.floor((dayNumber + 3) / 7);'],
  ['windows: repetition includes the end of the duration', 'src/core/schedule/windows.ts', 'for (; j * interval < duration; j++)', 'for (; j * interval <= duration; j++)'],
  ['windows: daily interval misaligned', 'src/core/schedule/windows.ts', "case 'daily': return n => n >= startDay && (n - startDay) % t.daysInterval === 0;", "case 'daily': return n => n >= startDay && (n - startDay + 1) % t.daysInterval === 0;"],
  ['windows: last day is the day before', 'src/core/schedule/windows.ts', '(t.lastDay && c.day === daysInMonth(c.year, c.month))', '(t.lastDay && c.day === daysInMonth(c.year, c.month) - 1)'],
  // Phase 3: generated commands
  ['commands: PowerShell quotes not doubled', 'src/core/schedule/commands.ts', 'ch => ch + ch', 'ch => ch'],
  ['commands: curly quotes not escaped for PowerShell', 'src/core/schedule/commands.ts', "const PS_QUOTE_CHARS = /['\\u2018\\u2019\\u201a\\u201b]/g;", "const PS_QUOTE_CHARS = /[']/g;"],
  ['commands: cmd.exe metacharacters passed through', 'src/core/schedule/commands.ts', 'const CMD_UNSAFE = /["%!^&|<>]/;', 'const CMD_UNSAFE = /["]/;'],
  ['commands: PowerShell start boundary left in UTC', 'src/core/schedule/commands.ts', '    `$trigger.StartBoundary = ${at}`,\n', ''],
  ['commands: running tasks stopped at the end of the repetition', 'src/core/schedule/commands.ts', "'$trigger.Repetition.StopAtDurationEnd = $false'", "'$trigger.Repetition.StopAtDurationEnd = $true'"],
  ['commands: program path with spaces not quoted in /TR', 'src/core/schedule/commands.ts', "details.program.includes(' ') ?", "details.program.includes('  ') ?"],
  ['commands: /DU with two-digit hours', 'src/core/schedule/commands.ts', "return `${String(Math.floor(minutes / 60)).padStart(4, '0')}", "return `${String(Math.floor(minutes / 60)).padStart(2, '0')}"],
  ['commands: /TR length limit not enforced', 'src/core/schedule/commands.ts', 'else if (full.length > SCHTASKS_TR_LIMIT)', 'else if (full.length > SCHTASKS_TR_LIMIT * 2)'],
  // Phase 3: builder and reports
  ['builder: every 7 minutes labeled exact for Windows', 'src/core/schedule/builder.ts', "if (s.frequency === 'minutes' && 60 % s.everyMinutes !== 0) {", 'if (false) {'],
  ['builder: cron offered for every 2 weeks', 'src/core/schedule/builder.ts', "if (s.everyWeeks > 1) return unsupported('cron'", "if (false) return unsupported('cron'"],
  ['builder: systemd first week starts on the 2nd', 'src/core/schedule/builder.ts', "{ 1: '01..07',", "{ 1: '02..08',"],
  ['builder: Quartz weekday number off by one', 'src/core/schedule/builder.ts', '`${t} ? * ${mo.weekday + 1}${', '`${t} ? * ${mo.weekday}${'],
  ['builder: every N weeks ignores the interval', 'src/core/schedule/builder.ts', 'return n >= first && (weekIndex(n) - firstWeek) % s.everyWeeks === 0;', 'return n >= first;'],
  ['reports: numeric zone names shown as abbreviations', 'src/core/schedule/reports.ts', "return /^[A-Z]{2,5}$/.test(name) ? name : '';", 'return name;'],
];

for (const name of readdirSync(join(ROOT, 'scripts')).filter(n => /^mutations-phase[0-9].*\.json$/.test(n)).sort()) {
  for (const group of JSON.parse(readFileSync(join(ROOT, 'scripts', name), 'utf8'))) {
    for (const [label, file, from, to] of group.mutations) MUTATIONS.push([label, file, from, to, group.tests]);
  }
}

function run(cwd, args) {
  return spawnSync(process.execPath, [join(cwd, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...args], { cwd, encoding: 'utf8' });
}

const filter = process.argv[2];
const selected = MUTATIONS.filter(([label]) => !filter || label.includes(filter));
const work = mkdtempSync(join(tmpdir(), 'netforge-mutations-'));
try {
  for (const entry of ['src', 'tests', 'scripts', 'public', 'data', 'package.json', 'tsconfig.json', 'vite.config.ts', 'index.html', '.gitignore', '.gitattributes', 'README.md', 'CHANGELOG.md']) {
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
  for (const [label, file, from, to, tests = []] of selected) {
    const path = join(work, file);
    const original = readFileSync(path, 'utf8');
    const count = original.split(from).length - 1;
    if (count !== 1) {
      console.error(`SETUP ERROR ${label}: expected the text once in ${file}, found ${count} times`);
      survivors.push(`${label} (setup error)`);
      continue;
    }
    writeFileSync(path, original.replace(from, () => to));
    const result = run(work, [...tests, '--bail', '1']);
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
