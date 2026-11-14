/**
 * What the two device targets (Cisco IOS / IOS-XE and Juniper Junos) share: the device context a
 * plan does not hold, and the checks on plan text before it is written into a configuration line.
 *
 * A plan says which VRF a VLAN routes in. It does not say which of its VRFs is a device's global
 * routing table, or what a VRF is called on the device. Both are asked for, never guessed: a
 * gateway interface written into the wrong routing table is the kind of mistake a preview must
 * not make.
 */
import type { Plan } from '../plan/model';
import type { ExportScope, ResolvedVlan } from './source';
import { isPrintableAscii } from './text';

/** The answer to "which VRF of the plan is this device's global routing table?" */
export const GLOBAL_UNSET = '';
export const GLOBAL_NONE = '-';

export interface DeviceContext {
  readonly scope: ExportScope;
  /** A VRF id, GLOBAL_NONE (every VRF is a named VRF on the device) or GLOBAL_UNSET (not answered yet). */
  readonly globalVrfId: string;
  /** The name each plan VRF has on the device, by VRF id. Missing or empty means not given. */
  readonly vrfNames: Readonly<Record<string, string>>;
}

export type VrfPlacement =
  | { readonly kind: 'global' }
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/** Where a VLAN's gateway interface belongs on the device, or why that is not known. */
export function placeVrf(v: ResolvedVlan, context: DeviceContext, pattern: RegExp, maxLength: number, what: string): VrfPlacement {
  if (!v.vrf) return { kind: 'unknown', reason: 'The VLAN has no VRF in the plan.' };
  if (context.globalVrfId === GLOBAL_UNSET) return { kind: 'unknown', reason: 'Say which VRF of the plan is this device\'s global routing table (or that none is). The plan does not hold that.' };
  if (context.globalVrfId === v.vrf.id) return { kind: 'global' };
  const name = Object.hasOwn(context.vrfNames, v.vrf.id) ? context.vrfNames[v.vrf.id]!.trim() : '';
  const planName = v.vrf.name.trim() || v.vrf.id;
  if (name === '') return { kind: 'unknown', reason: `Enter the name VRF "${planName}" has on the device. The ${what} must match the device exactly.` };
  if (name.length > maxLength || !pattern.test(name)) return { kind: 'unknown', reason: `"${name.slice(0, 40)}" is not a valid ${what}: use one word of letters, digits, hyphens and underscores, ${maxLength} characters at most.` };
  return { kind: 'named', name };
}

export const DESCRIPTION_MAX = 200;

/**
 * Free text for a description line: printable ASCII only, without the characters in `forbidden`,
 * at most DESCRIPTION_MAX characters. Returns the reason it cannot be written, or null.
 */
export function descriptionProblem(text: string, forbidden: RegExp, forbiddenShown: string): string | null {
  if (!isPrintableAscii(text)) return 'it has characters outside printable ASCII (or a line break)';
  if (forbidden.test(text)) return `it contains ${forbiddenShown}`;
  if (text.length > DESCRIPTION_MAX) return `it is longer than ${DESCRIPTION_MAX} characters`;
  return null;
}

/** VLAN IDs that appear more than once in the list (a selection spanning several VLAN namespaces). */
export function duplicateVlanNumbers(vlans: readonly ResolvedVlan[]): Map<number, ResolvedVlan[]> {
  const byNumber = new Map<number, ResolvedVlan[]>();
  for (const v of vlans) {
    if (v.number === null) continue;
    const list = byNumber.get(v.number);
    if (list) list.push(v);
    else byNumber.set(v.number, [v]);
  }
  for (const [n, list] of [...byNumber]) if (list.length < 2) byNumber.delete(n);
  return byNumber;
}

/** The VRFs used by the VLANs of a scope, in plan order: the ones a device export asks names for. */
export function vrfsInScope(plan: Plan, scope: ExportScope): { id: string; name: string }[] {
  const used = new Set(plan.vlans.filter(v => (scope.siteId === '' || v.siteId === scope.siteId) && (scope.vrfId === '' || v.vrfId === scope.vrfId) && (scope.namespaceId === '' || v.namespaceId === scope.namespaceId)).map(v => v.vrfId));
  return plan.vrfs.filter(v => used.has(v.id)).map(v => ({ id: v.id, name: v.name.trim() || v.id }));
}
