/** Types for the generated IANA registry data (registry-data.ts). */

/** A registry column value: True, False, N/A, or left blank (as for deprecated blocks). */
export type RegistryFlag = 'true' | 'false' | 'n/a' | 'unspecified';

export type RegistryTag =
  | 'private-use'
  | 'shared-address-space'
  | 'loopback'
  | 'link-local'
  | 'documentation'
  | 'benchmarking'
  | 'reserved'
  | 'unspecified'
  | 'this-network'
  | 'limited-broadcast'
  | 'protocol-assignment'
  | 'anycast'
  | 'translation'
  | 'tunneling'
  | 'discard'
  | 'ipv4-mapped'
  | 'deprecated';

/** One row of the IANA IPv4 or IPv6 Special-Purpose Address Registry. */
export interface RegistryRow {
  readonly family: 4 | 6;
  readonly block: string;
  readonly name: string;
  readonly rfc: string;
  readonly allocated: string;
  readonly terminated: string | null;
  readonly source: RegistryFlag;
  readonly destination: RegistryFlag;
  readonly forwardable: RegistryFlag;
  readonly globallyReachable: RegistryFlag;
  readonly reservedByProtocol: RegistryFlag;
  /** Registry footnotes that apply to this row. */
  readonly notes: readonly string[];
  readonly tags: readonly RegistryTag[];
}

/** One row of the IANA IPv6 Address Space registry (top-level allocations). */
export interface AddressSpaceRow {
  readonly block: string;
  readonly allocation: string;
  readonly reference: string;
  readonly notes: string;
}
