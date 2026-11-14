/**
 * The plan file: versioned JSON, written and read only when the user asks.
 *
 * Reading is strict about structure and lenient about content. The text must be valid JSON
 * without duplicate names (checked by the strict scanner, so nothing is silently dropped), carry
 * the format name and a supported version, and have the right types and sane sizes. Content
 * problems (a bad network, a missing site) are not refused here: the plan opens and validation
 * reports them where they are, exactly as if they had been typed.
 *
 * Round trip: saving a plan and opening the file gives back the same plan, field for field.
 */
import { analyzeJson } from '../data/json';
import { fail, ok, type Result } from '../result';
import { ID_PATTERN, type Ipv4Settings, type Ipv6Settings, type ParentBlock, type Plan, type ReservedEntry, type Site, type Vlan, type VlanNamespace, type Vrf } from './model';

export const PLAN_FORMAT = 'netforge-plan';
export const PLAN_VERSION = 1;
/** Characters of JSON text accepted, about 20 MB. */
export const MAX_PLAN_CHARS = 20_000_000;

export const LIMITS = {
  sites: 2_000,
  vrfs: 2_000,
  namespaces: 2_000,
  vlans: 20_000,
  blocksPerSite: 256,
  entriesPerList: 512,
  shortText: 500,
  longText: 20_000,
} as const;

export type PlanFileErrorCode = 'empty' | 'too-large' | 'not-json' | 'duplicate-key' | 'not-plan' | 'unsupported-version' | 'invalid-version' | 'invalid-structure';

export interface LoadedPlan {
  readonly plan: Plan;
  /** Fields that were not recognized and were left out. */
  readonly warnings: readonly string[];
}

const CANONICAL_INT = /^(0|[1-9][0-9]{0,14})$/;
const numberOrText = (text: string): number | string => (CANONICAL_INT.test(text) ? Number(text) : text);

/** The plan as file text: fixed key order, two-space indent, final newline. */
export function planToJson(plan: Plan): string {
  const reserved = (list: readonly ReservedEntry[]) => list.map(r => ({ range: r.range, label: r.label }));
  const file = {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    plan: {
      name: plan.name,
      description: plan.description,
      sites: plan.sites.map(s => ({
        id: s.id, name: s.name, description: s.description, notes: s.notes,
        blocks: s.blocks.map(b => ({ id: b.id, network: b.network, vrfId: b.vrfId, description: b.description, reserved: reserved(b.reserved) })),
      })),
      vrfs: plan.vrfs.map(v => ({ id: v.id, name: v.name, siteId: v.siteId, exchangesWith: [...v.exchangesWith], description: v.description, notes: v.notes })),
      namespaces: plan.namespaces.map(n => ({ id: n.id, name: n.name, siteId: n.siteId, description: n.description })),
      vlans: plan.vlans.map(v => ({
        id: v.id, vlanId: numberOrText(v.vlanId), name: v.name, siteId: v.siteId, namespaceId: v.namespaceId, vrfId: v.vrfId,
        hosts: numberOrText(v.hosts), description: v.description, notes: v.notes,
        ipv4: { network: v.ipv4.network, gateway: v.ipv4.gateway, dhcp: [...v.ipv4.dhcp], fixed: v.ipv4.fixed },
        ipv6: { prefixes: [...v.ipv6.prefixes], gateway: v.ipv6.gateway, fixed: v.ipv6.fixed },
        reserved: reserved(v.reserved),
      })),
    },
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

class StructureError extends Error {}

type Obj = Record<string, unknown>;

class Reader {
  readonly warnings: string[] = [];
  private unknownCount = 0;

  object(value: unknown, path: string, known: readonly string[]): Obj {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new StructureError(`${path} must be an object.`);
    const o = value as Obj;
    for (const key of Object.keys(o)) {
      if (known.includes(key)) continue;
      this.unknownCount++;
      if (this.warnings.length < 20) this.warnings.push(`${path}.${key} is not part of the plan format and was left out.`);
    }
    return o;
  }

  finish(): string[] {
    if (this.unknownCount > this.warnings.length) this.warnings.push(`${this.unknownCount - this.warnings.length} more unrecognized fields were left out.`);
    return this.warnings;
  }

  text(o: Obj, key: string, path: string, max: number = LIMITS.shortText): string {
    if (!Object.hasOwn(o, key) || o[key] === undefined) return '';
    const v = o[key];
    if (typeof v !== 'string') throw new StructureError(`${path}.${key} must be text.`);
    if (v.length > max) throw new StructureError(`${path}.${key} is longer than ${max} characters.`);
    return v;
  }

  /** Text, or a whole number written as a JSON number (VLAN IDs and host targets). */
  textOrInt(o: Obj, key: string, path: string): string {
    const v = Object.hasOwn(o, key) ? o[key] : undefined;
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || v < 0) throw new StructureError(`${path}.${key} must be a whole number of 0 or more, or text.`);
      return String(v);
    }
    return this.text(o, key, path);
  }

  bool(o: Obj, key: string, path: string): boolean {
    if (!Object.hasOwn(o, key) || o[key] === undefined) return false;
    if (typeof o[key] !== 'boolean') throw new StructureError(`${path}.${key} must be true or false.`);
    return o[key] as boolean;
  }

  list(o: Obj, key: string, path: string, max: number): unknown[] {
    if (!Object.hasOwn(o, key) || o[key] === undefined) return [];
    const v = o[key];
    if (!Array.isArray(v)) throw new StructureError(`${path}.${key} must be a list.`);
    if (v.length > max) throw new StructureError(`${path}.${key} has ${v.length} entries; the limit is ${max}.`);
    return v;
  }

  texts(o: Obj, key: string, path: string): string[] {
    return this.list(o, key, path, LIMITS.entriesPerList).map((v, i) => {
      if (typeof v !== 'string') throw new StructureError(`${path}.${key}[${i}] must be text.`);
      if (v.length > LIMITS.shortText) throw new StructureError(`${path}.${key}[${i}] is longer than ${LIMITS.shortText} characters.`);
      return v;
    });
  }

  id(o: Obj, path: string, seen: Set<string>): string {
    const v = o.id;
    if (typeof v !== 'string' || !ID_PATTERN.test(v)) throw new StructureError(`${path}.id must be 1 to 64 letters, digits, dots, colons, hyphens or underscores.`);
    if (seen.has(v)) throw new StructureError(`${path}.id "${v}" is used twice.`);
    seen.add(v);
    return v;
  }

  reserved(o: Obj, key: string, path: string): ReservedEntry[] {
    return this.list(o, key, path, LIMITS.entriesPerList).map((v, i) => {
      const p = `${path}.${key}[${i}]`;
      const e = this.object(v, p, ['range', 'label']);
      return { range: this.text(e, 'range', p), label: this.text(e, 'label', p) };
    });
  }
}

export function parsePlanJson(text: string): Result<LoadedPlan, PlanFileErrorCode> {
  if (text.trim() === '') return fail('empty', 'The file is empty.');
  if (text.length > MAX_PLAN_CHARS) return fail('too-large', `The file is larger than ${MAX_PLAN_CHARS / 1_000_000} MB, the most a plan file may be.`);
  const scan = analyzeJson(text, { kind: 'validate' }, { maxWarnings: 5 });
  if (!scan.ok) return fail('not-json', `The file is not valid JSON: ${scan.error.message} (line ${scan.error.location.line}, column ${scan.error.location.column}).`);
  const dup = scan.warnings.find(w => w.code === 'duplicate-key');
  if (dup) return fail('duplicate-key', `The file has a duplicate field, which would make it ambiguous: ${dup.message} (line ${dup.location.line}).`);
  const root: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (typeof root !== 'object' || root === null || Array.isArray(root) || (root as Obj).format !== PLAN_FORMAT) {
    return fail('not-plan', 'This is not a NetForge plan file (it has no "format": "netforge-plan").');
  }
  const version = (root as Obj).version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return fail('invalid-version', 'The plan file has no valid version number.');
  if (version > PLAN_VERSION) return fail('unsupported-version', `This plan file uses format version ${version}, which is newer than this version of NetForge reads (version ${PLAN_VERSION}). Open it with a newer NetForge.`);

  const r = new Reader();
  try {
    const top = r.object(root, 'file', ['format', 'version', 'plan']);
    const p = r.object(top.plan, 'plan', ['name', 'description', 'sites', 'vrfs', 'namespaces', 'vlans']);
    const siteIds = new Set<string>();
    const blockIds = new Set<string>();
    const sites: Site[] = r.list(p, 'sites', 'plan', LIMITS.sites).map((raw, i) => {
      const path = `plan.sites[${i}]`;
      const s = r.object(raw, path, ['id', 'name', 'description', 'notes', 'blocks']);
      const blocks: ParentBlock[] = r.list(s, 'blocks', path, LIMITS.blocksPerSite).map((rawB, j) => {
        const bp = `${path}.blocks[${j}]`;
        const b = r.object(rawB, bp, ['id', 'network', 'vrfId', 'description', 'reserved']);
        return { id: r.id(b, bp, blockIds), network: r.text(b, 'network', bp), vrfId: r.text(b, 'vrfId', bp), description: r.text(b, 'description', bp, LIMITS.longText), reserved: r.reserved(b, 'reserved', bp) };
      });
      return { id: r.id(s, path, siteIds), name: r.text(s, 'name', path), description: r.text(s, 'description', path, LIMITS.longText), notes: r.text(s, 'notes', path, LIMITS.longText), blocks };
    });
    const vrfIds = new Set<string>();
    const vrfs: Vrf[] = r.list(p, 'vrfs', 'plan', LIMITS.vrfs).map((raw, i) => {
      const path = `plan.vrfs[${i}]`;
      const v = r.object(raw, path, ['id', 'name', 'siteId', 'exchangesWith', 'description', 'notes']);
      return { id: r.id(v, path, vrfIds), name: r.text(v, 'name', path), siteId: r.text(v, 'siteId', path), exchangesWith: r.texts(v, 'exchangesWith', path), description: r.text(v, 'description', path, LIMITS.longText), notes: r.text(v, 'notes', path, LIMITS.longText) };
    });
    const nsIds = new Set<string>();
    const namespaces: VlanNamespace[] = r.list(p, 'namespaces', 'plan', LIMITS.namespaces).map((raw, i) => {
      const path = `plan.namespaces[${i}]`;
      const n = r.object(raw, path, ['id', 'name', 'siteId', 'description']);
      return { id: r.id(n, path, nsIds), name: r.text(n, 'name', path), siteId: r.text(n, 'siteId', path), description: r.text(n, 'description', path, LIMITS.longText) };
    });
    const vlanIds = new Set<string>();
    const vlans: Vlan[] = r.list(p, 'vlans', 'plan', LIMITS.vlans).map((raw, i) => {
      const path = `plan.vlans[${i}]`;
      const v = r.object(raw, path, ['id', 'vlanId', 'name', 'siteId', 'namespaceId', 'vrfId', 'hosts', 'description', 'notes', 'ipv4', 'ipv6', 'reserved']);
      const v4 = v.ipv4 === undefined ? {} : r.object(v.ipv4, `${path}.ipv4`, ['network', 'gateway', 'dhcp', 'fixed']);
      const v6 = v.ipv6 === undefined ? {} : r.object(v.ipv6, `${path}.ipv6`, ['prefixes', 'gateway', 'fixed']);
      const ipv4: Ipv4Settings = { network: r.text(v4, 'network', `${path}.ipv4`), gateway: r.text(v4, 'gateway', `${path}.ipv4`), dhcp: r.texts(v4, 'dhcp', `${path}.ipv4`), fixed: r.bool(v4, 'fixed', `${path}.ipv4`) };
      const ipv6: Ipv6Settings = { prefixes: r.texts(v6, 'prefixes', `${path}.ipv6`), gateway: r.text(v6, 'gateway', `${path}.ipv6`), fixed: r.bool(v6, 'fixed', `${path}.ipv6`) };
      return {
        id: r.id(v, path, vlanIds), vlanId: r.textOrInt(v, 'vlanId', path), name: r.text(v, 'name', path),
        siteId: r.text(v, 'siteId', path), namespaceId: r.text(v, 'namespaceId', path), vrfId: r.text(v, 'vrfId', path),
        hosts: r.textOrInt(v, 'hosts', path), description: r.text(v, 'description', path, LIMITS.longText), notes: r.text(v, 'notes', path, LIMITS.longText),
        ipv4, ipv6, reserved: r.reserved(v, 'reserved', path),
      };
    });
    const plan: Plan = { name: r.text(p, 'name', 'plan'), description: r.text(p, 'description', 'plan', LIMITS.longText), sites, vrfs, namespaces, vlans };
    return ok({ plan, warnings: r.finish() });
  } catch (e) {
    if (e instanceof StructureError) return fail('invalid-structure', `The plan file is damaged or was edited incorrectly: ${e.message}`);
    throw e;
  }
}
