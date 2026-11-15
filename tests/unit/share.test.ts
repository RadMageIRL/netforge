/**
 * Share links: the format, the reader's refusals, and each tool's settings round trip. Every
 * reader is shown to refuse unknown keys, bad values and contradictions, so a link can only ever
 * restore settings a tool would accept from its own controls.
 */
import { describe, expect, it } from 'vitest';
import {
  encodeValue, homeLink, intIn, MAX_LINK_CHARS, MAX_PARAMS, oneOf, onlyKeys, readShareQuery, settingsLink, SHARE_ORIGIN, toolLink, zoneName, type ShareOffer, type ShareParams,
} from '../../src/app/share';
import { createCatalog } from '../../src/app/catalog';
import { chmodOffer, readChmodShare } from '../../src/tools/chmod-calculator/chmod-share';
import { cronOffer, readCronShare } from '../../src/tools/cron-explainer/cron-share';
import { numberOffer, readNumberShare } from '../../src/tools/number-bases/number-share';
import { builderOffer, BUILDER_DEFAULTS, readBuilderShare, type BuilderShare } from '../../src/tools/schedule-builder/builder-share';
import { readSubnetShare, subnetOffer } from '../../src/tools/subnet-calculator/subnet-share';
import { readTimestampShare, timestampOffer } from '../../src/tools/timestamp-converter/timestamp-share';
import { readTokenShare, tokenOffer } from '../../src/tools/uuid-tokens/uuid-share';

const own = `${'https'}://netforge.radmagelabs.com/`;

/** The fragment of a full link, as location.hash would hold it. */
const fragment = (link: string) => link.slice(link.indexOf('#'));
/** Writes params into a link and reads them back the way the app does. */
function roundTrip(id: string, params: ShareParams): ReadonlyMap<string, string> {
  const link = settingsLink(id, params);
  expect(link).not.toBeNull();
  const read = readShareQuery(fragment(link!));
  expect(read.kind).toBe('settings');
  return read.kind === 'settings' ? read.params : new Map();
}
function okParams(offer: ShareOffer): ShareParams {
  expect(offer.ok).toBe(true);
  return offer.ok ? offer.params : [];
}
/** A link's settings from a plain object (test cases vary in which keys they name). */
const map = (entries: object) => new Map(Object.entries(entries) as [string, string][]);

describe('link format', () => {
  it('tool links are the public address and the route, for every tool', () => {
    expect(SHARE_ORIGIN).toBe(own);
    expect(homeLink()).toBe(own);
    for (const tool of createCatalog().list()) {
      expect(toolLink(tool.id)).toBe(`${own}#/${tool.id}`);
      expect(readShareQuery(fragment(toolLink(tool.id)))).toEqual({ kind: 'none' });
    }
  });

  it('settings links carry the version first and stay readable', () => {
    expect(settingsLink('subnet-calculator', [['ip', '192.0.2.10/24'], ['split', '26']])).toBe(`${own}#/subnet-calculator?v=1&ip=192.0.2.10/24&split=26`);
    expect(settingsLink('cron-explainer', [['expr', '0 9 * * 1-5'], ['tz', 'Europe/Berlin']])).toBe(`${own}#/cron-explainer?v=1&expr=0%209%20*%20*%201-5&tz=Europe/Berlin`);
    // The separators and characters with meaning in a fragment or a form stay encoded.
    expect(encodeValue('a&b=c#d+e%f?g h')).toBe('a%26b%3Dc%23d%2Be%25f%3Fg%20h');
  });

  it('refuses to write a link that is too long or malformed', () => {
    expect(settingsLink('x', [['a', 'x'.repeat(257)]])).toBeNull();
    expect(settingsLink('x', Array.from({ length: 40 }, (_v, i) => [`k${i}`, 'x'.repeat(200)] as const))).toBeNull();
    expect(settingsLink('x', Array.from({ length: MAX_PARAMS }, (_v, i) => [`k${i}`, '1'] as const))).toBeNull();
    expect(settingsLink('x', [['Bad', '1']])).toBeNull();
    expect(settingsLink('x', [['v', '2']])).toBeNull();
    expect(settingsLink('x', [['a', '1'], ['a', '2']])).toBeNull();
    expect(settingsLink('x', [['a', 'line\nbreak']])).toBeNull();
    // Each value and the count are within limits; only the whole link is too long.
    const five = Array.from({ length: 5 }, (_v, i) => [`k${i}`, 'x'.repeat(250)] as const);
    expect(settingsLink('x', five.slice(0, 3))!.length).toBeLessThanOrEqual(MAX_LINK_CHARS);
    expect(settingsLink('x', five)).toBeNull();
  });
});

describe('reading links', () => {
  it('reads nothing from a plain route', () => {
    for (const hash of ['', '#', '#/', '#/subnet-calculator', '#/subnet-calculator?']) expect(readShareQuery(hash)).toEqual({ kind: 'none' });
  });

  it('reads well-formed settings without the version', () => {
    expect(readShareQuery('#/subnet-calculator?v=1&ip=192.0.2.10/24')).toEqual({ kind: 'settings', params: map({ ip: '192.0.2.10/24' }) });
    expect(readShareQuery('#/x?v=1&a=%20b%2Bc')).toEqual({ kind: 'settings', params: map({ a: ' b+c' }) });
  });

  it('refuses the whole link for each kind of problem', () => {
    const refused = (hash: string) => { const r = readShareQuery(hash); return r.kind === 'refused' ? r.reason : r.kind; };
    expect(refused(`#/x?v=1&a=${'b'.repeat(MAX_LINK_CHARS)}`)).toBe('too-long');
    // Every value and the count are within limits; only the whole fragment is too long.
    expect(refused(`#/x?v=1&${Array.from({ length: 5 }, (_v, i) => `k${i}=${'x'.repeat(250)}`).join('&')}`)).toBe('too-long');
    expect(refused(`#/x?v=1&${Array.from({ length: 3 }, (_v, i) => `k${i}=${'x'.repeat(250)}`).join('&')}`)).toBe('settings');
    expect(refused(`#/x?v=1&${Array.from({ length: MAX_PARAMS }, (_v, i) => `k${i}=1`).join('&')}`)).toBe('too-long');
    expect(refused('#/x?v=1&a=%E0%A4%A')).toBe('malformed');
    expect(refused('#/x?v=1&a')).toBe('malformed');
    expect(refused('#/x?v=1&=a')).toBe('malformed');
    expect(refused('#/x?v=1&A=1')).toBe('malformed');
    expect(refused('#/x?v=1&a.b=1')).toBe('malformed');
    expect(refused('#/x?v=1&a=1&&b=2')).toBe('malformed');
    expect(refused('#/x?v=1&a=%0A')).toBe('malformed');
    expect(refused('#/x?v=1&a=%7F')).toBe('malformed');
    expect(refused(`#/x?v=1&a=${encodeURIComponent(String.fromCharCode(0xe9))}`)).toBe('malformed');
    expect(refused(`#/x?v=1&a=${'b'.repeat(257)}`)).toBe('too-long');
    expect(refused('#/x?a=1')).toBe('version');
    expect(refused('#/x?v=2&a=1')).toBe('version');
    expect(refused('#/x?v=01&a=1')).toBe('version');
    expect(refused('#/x?v=1&a=1&a=1')).toBe('duplicate');
    expect(refused('#/x?v=1&v=1')).toBe('duplicate');
  });

  it('helpers accept only exact, bounded values', () => {
    expect(onlyKeys(map({ a: '1', b: '2' }), ['a', 'b', 'c'])).toBe(true);
    expect(onlyKeys(map({ a: '1', d: '2' }), ['a', 'b'])).toBe(false);
    expect([intIn('7', 1, 9), intIn('07', 1, 9), intIn('10', 1, 9), intIn('-1', 0, 9), intIn('1.5', 0, 9), intIn(' 1', 0, 9), intIn('1e3', 0, 9999), intIn(undefined, 0, 9)]).toEqual([7, 7, null, null, null, null, null, null]);
    expect([oneOf('a', ['a', 'b']), oneOf('A', ['a']), oneOf(undefined, ['a'])]).toEqual(['a', null, null]);
    expect(['UTC', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5'].map(zoneName)).toEqual(['UTC', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5']);
    expect(['', '../x', 'Europe//Berlin', 'Europe/Berlin ', '<b>', 'a'.repeat(65)].map(zoneName)).toEqual([null, null, null, null, null, null]);
  });
});

describe('Subnet Calculator', () => {
  it('shares the canonical address and prefix, and the open split and supernet lengths', () => {
    const offer = subnetOffer(4, ' 172.16.5.4 255.255.240.0 ', 24, 18);
    expect(okParams(offer)).toEqual([['ip', '172.16.5.4/20'], ['split', '24'], ['super', '18']]);
    expect(readSubnetShare(roundTrip('subnet-calculator', okParams(offer)))).toEqual({ family: 4, text: '172.16.5.4/20', length: 20, split: 24, supernet: 18 });
    const v6 = subnetOffer(6, '2001:0DB8:0:0::1/64', null, null);
    expect(okParams(v6)).toEqual([['ip', '2001:db8::1/64']]);
    expect(readSubnetShare(roundTrip('subnet-calculator', okParams(v6)))).toMatchObject({ family: 6, text: '2001:db8::1/64', split: null, supernet: null });
    expect(subnetOffer(4, '', null, null).ok).toBe(false);
    expect(subnetOffer(4, '300.1.1.1/24', null, null).ok).toBe(false);
  });

  it('refuses links it cannot use', () => {
    for (const bad of [
      {}, { ip: '' }, { ip: '192.0.2.1' }, { ip: '192.0.2.1/33' }, { ip: '192.0.2.1 255.255.255.0' }, { ip: 'fe80::1%eth0/64' }, { ip: '2001:db8::/129' },
      { ip: '192.0.2.0/24', split: '24' }, { ip: '192.0.2.0/24', split: '33' }, { ip: '192.0.2.0/24', super: '24' }, { ip: '192.0.2.0/24', split: 'x' },
      { ip: '192.0.2.0/24', family: '6' }, { ip: '192.0.2.0/24', note: 'x' },
    ]) expect(readSubnetShare(map(bad))).toBeNull();
  });
});

describe('chmod Calculator', () => {
  it('shares the mode and the file type, never the path', () => {
    const offer = chmodOffer({ mode: 0o2775, directory: true });
    expect(okParams(offer)).toEqual([['mode', '2775'], ['type', 'directory']]);
    expect(offer.ok && offer.summary.join(' ')).toContain('Not included: the path');
    expect(readChmodShare(roundTrip('chmod-calculator', okParams(offer)))).toEqual({ mode: 0o2775, directory: true });
    expect(readChmodShare(map({ mode: '644' }))).toEqual({ mode: 0o644, directory: false });
  });

  it('refuses links it cannot use', () => {
    for (const bad of [{}, { mode: '8' }, { mode: '64' }, { mode: '77777' }, { mode: 'rwx' }, { mode: '644', type: 'dir' }, { mode: '644', path: '/etc/shadow' }]) {
      expect(readChmodShare(map(bad))).toBeNull();
    }
  });
});

describe('UUID / Random Tokens', () => {
  it('shares the options and never a value', () => {
    const uuid = tokenOffer('uuid-v7', '25', '32');
    expect(okParams(uuid)).toEqual([['kind', 'uuid-v7'], ['count', '25']]);
    expect(readTokenShare(roundTrip('uuid-tokens', okParams(uuid)))).toEqual({ kind: 'uuid-v7', count: 25, bytes: null });
    const hex = tokenOffer('hex', '3', '16');
    expect(okParams(hex)).toEqual([['kind', 'hex'], ['count', '3'], ['bytes', '16']]);
    expect(readTokenShare(roundTrip('uuid-tokens', okParams(hex)))).toEqual({ kind: 'hex', count: 3, bytes: 16 });
    expect(tokenOffer('hex', '0', '16').ok).toBe(false);
    expect(tokenOffer('base64url', '1', '2000').ok).toBe(false);
  });

  it('refuses links it cannot use', () => {
    for (const bad of [{}, { kind: 'uuid-v1' }, { kind: 'uuid-v4', count: '1001' }, { kind: 'uuid-v4', bytes: '16' }, { kind: 'hex', bytes: '0' }, { kind: 'hex', value: 'abcd' }]) {
      expect(readTokenShare(map(bad))).toBeNull();
    }
  });
});

describe('Number Bases & Bytes', () => {
  const base = { number: null, base: 10 as const, width: 32, signed: false, group: 4 as const, amount: null, unit: 'GiB' };

  it('shares a number that converts, with its settings, and a storage amount', () => {
    const offer = numberOffer({ ...base, number: '-2', width: 16, signed: true, amount: '1.5', unit: 'TB' });
    expect(okParams(offer)).toEqual([['n', '-2'], ['base', '10'], ['width', '16'], ['sign', 'signed'], ['group', '4'], ['amount', '1.5'], ['unit', 'TB']]);
    expect(readNumberShare(roundTrip('number-bases', okParams(offer)))).toEqual({ ...base, number: '-2', width: 16, signed: true, amount: '1.5', unit: 'TB' });
    const custom = numberOffer({ ...base, number: 'ff_ff', base: 16, width: 24, group: 8 });
    expect(readNumberShare(roundTrip('number-bases', okParams(custom)))).toEqual({ ...base, number: 'ff_ff', base: 16, width: 24, group: 8 });
    const none = numberOffer({ ...base, number: '123456789012345678901234567890', width: null });
    expect(readNumberShare(roundTrip('number-bases', okParams(none)))).toMatchObject({ width: null });
    expect(numberOffer({ ...base, number: '300', width: 8 }).ok).toBe(false);
    expect(numberOffer({ ...base, amount: 'lots' }).ok).toBe(false);
  });

  it('refuses links it cannot use', () => {
    for (const bad of [
      { n: '256', width: '8' }, { n: 'zz', base: '16' }, { n: '1', base: '3' }, { n: '1', width: '0' }, { n: '1', width: '4097' }, { n: '1', sign: 'both' }, { n: '1', group: '2' },
      { n: '1'.repeat(201), width: 'none' }, { n: '' }, { unit: 'GiB' }, { amount: '1', unit: 'parsec' }, { amount: '-1', unit: 'GiB' }, { n: '1', extra: '1' },
    ]) expect(readNumberShare(map(bad))).toBeNull();
  });
});

describe('Timestamp Converter', () => {
  it('shares the timestamp, the reading and a chosen zone, never the device zone', () => {
    const offer = timestampOffer({ text: ' 2026-11-01 01:30 ', mode: 'iso', zone: 'America/New_York', pick: 'later' });
    expect(okParams(offer)).toEqual([['ts', '2026-11-01 01:30'], ['mode', 'iso'], ['tz', 'America/New_York'], ['pick', 'later']]);
    expect(readTimestampShare(roundTrip('timestamp-converter', okParams(offer)))).toEqual({ text: '2026-11-01 01:30', mode: 'iso', zone: 'America/New_York', pick: 'later' });
    const device = timestampOffer({ text: '1700000000', mode: 'auto', zone: null, pick: 'earlier' });
    expect(okParams(device).map(([k]) => k)).toEqual(['ts', 'mode']);
    expect(device.ok && device.summary.join(' ')).toContain('Time zone: not included');
    expect(timestampOffer({ text: 'yesterday', mode: 'auto', zone: null, pick: 'earlier' }).ok).toBe(false);
  });

  it('refuses links it cannot use', () => {
    for (const bad of [{}, { ts: '' }, { ts: 'soon' }, { ts: '1700000000', mode: 'hours' }, { ts: '1700000000', tz: 'Mars/Olympus Mons' }, { ts: '1700000000', pick: 'both' }, { ts: '1'.repeat(65) }, { ts: '1', note: 'x' }]) {
      expect(readTimestampShare(map(bad))).toBeNull();
    }
  });
});

describe('Cron Explainer', () => {
  it('shares an expression that parses in its dialect, with a chosen zone and start', () => {
    const offer = cronOffer({ dialect: 'quartz', expression: ' 0 15 10 ? * 6L ', zone: 'Europe/Berlin', from: '2026-03-01 00:00' });
    expect(okParams(offer)).toEqual([['dialect', 'quartz'], ['expr', '0 15 10 ? * 6L'], ['tz', 'Europe/Berlin'], ['from', '2026-03-01 00:00']]);
    expect(readCronShare(roundTrip('cron-explainer', okParams(offer)))).toEqual({ dialect: 'quartz', expression: '0 15 10 ? * 6L', zone: 'Europe/Berlin', from: '2026-03-01 00:00' });
    const systemd = cronOffer({ dialect: 'systemd', expression: 'Mon..Fri 09:00', zone: null, from: '' });
    expect(readCronShare(roundTrip('cron-explainer', okParams(systemd)))).toEqual({ dialect: 'systemd', expression: 'Mon..Fri 09:00', zone: null, from: null });
    expect(cronOffer({ dialect: 'cron', expression: '0 0 * * * ?', zone: null, from: null }).ok).toBe(false);
    expect(cronOffer({ dialect: 'cron', expression: '', zone: null, from: null }).ok).toBe(false);
  });

  it('refuses links it cannot use', () => {
    for (const bad of [{}, { expr: '' }, { expr: '61 * * * *' }, { expr: '0 0 * * * ?' }, { dialect: 'at', expr: '* * * * *' }, { expr: '* * * * *', tz: '../../etc' }, { expr: '* * * * *', from: 'whenever' }, { expr: `* * * * * ${'x'.repeat(200)}` }, { expr: '* * * * *', cmd: 'rm' }]) {
      expect(readCronShare(map(bad))).toBeNull();
    }
  });
});

describe('Schedule Builder', () => {
  const choices = (over: Partial<BuilderShare>): BuilderShare => ({ ...BUILDER_DEFAULTS, zone: null, startDate: '2026-11-14', ...over });

  it('shares only the settings the frequency uses, and never names, programs or arguments', () => {
    const weekly = builderOffer(choices({ frequency: 'weekly', time: '06:30', weekday: '5', everyWeeks: '2', zone: 'Europe/London' }), 'America/New_York');
    expect(okParams(weekly)).toEqual([['freq', 'weekly'], ['time', '06:30'], ['day', '5'], ['weeks', '2'], ['tz', 'Europe/London'], ['start', '2026-11-14']]);
    expect(readBuilderShare(roundTrip('schedule-builder', okParams(weekly)))).toEqual(choices({ frequency: 'weekly', time: '06:30', weekday: '5', everyWeeks: '2', zone: 'Europe/London' }));
    const monthly = builderOffer(choices({ frequency: 'monthly', monthlyKind: 'nth', nth: 'last', nthWeekday: '0' }), 'UTC');
    expect(okParams(monthly).map(([k]) => k)).toEqual(['freq', 'time', 'monthly', 'nth', 'wday', 'start']);
    expect(readBuilderShare(roundTrip('schedule-builder', okParams(monthly)))).toMatchObject({ frequency: 'monthly', monthlyKind: 'nth', nth: 'last', nthWeekday: '0', zone: null });
    const days = builderOffer(choices({ frequency: 'days', weekdays: [5, 1, 3] }), 'UTC');
    expect(okParams(days)).toContainEqual(['days', '1,3,5']);
    for (const offer of [weekly, monthly, days]) expect(okParams(offer).filter(([k]) => /name|program|arg|format|date/.test(k))).toEqual([]);
    expect(weekly.ok && weekly.summary.join(' ')).toContain('Not included: the task or unit name, program, arguments');
    expect(builderOffer(choices({ frequency: 'minutes', everyMinutes: '90' }), 'UTC').ok).toBe(false);
  });

  it('refuses links it cannot use or that contradict themselves', () => {
    for (const bad of [
      {}, { freq: 'yearly' }, { freq: 'daily', time: '9:00' }, { freq: 'daily', time: '24:00' }, { freq: 'daily', every: '5' }, { freq: 'minutes', every: '60' },
      { freq: 'weekly', day: '7' }, { freq: 'days', days: '' }, { freq: 'days', days: '1,1' }, { freq: 'days', days: '1,8' }, { freq: 'monthly', monthly: 'day', nth: '2' },
      { freq: 'monthly', monthly: 'nth', nth: '5' }, { freq: 'monthly', monthly: 'day', mday: '32' }, { freq: 'daily', start: '2026-02-30' }, { freq: 'daily', tz: 'x y' },
      { freq: 'daily', name: 'Backup' }, { freq: 'daily', program: 'C:\\run.exe' }, { freq: 'daily', args: '-x' },
    ]) expect(readBuilderShare(map(bad))).toBeNull();
  });
});
