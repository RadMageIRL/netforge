/**
 * The shared export model. Every export target (PowerShell, Terraform, Cisco IOS, Junos, plain
 * JSON) returns the same shape: text files to review, and an account of what was written for each
 * part of the plan.
 *
 * Three labels, used everywhere:
 * - exact: the target states what the plan states.
 * - approximate: something was written, but it differs from the plan or leaves part of it out.
 *   The notes say what.
 * - unsupported: nothing was written for this item, and the reason is given.
 *
 * Nothing is left out without a note. An export is text for a person to review: nothing here runs
 * a command, opens a connection or applies a configuration.
 */

export type Fidelity = 'exact' | 'approximate' | 'unsupported';

export const FIDELITY_LABEL: Readonly<Record<Fidelity, string>> = { exact: 'Exact', approximate: 'Approximate', unsupported: 'Unsupported' };

/** One field of an item that differs from the plan or could not be written. */
export interface FieldNote {
  readonly fidelity: 'approximate' | 'unsupported';
  readonly field: string;
  readonly detail: string;
}

export interface ExportItem {
  /** "VLAN 10 Users", "VPC for Headquarters / Global". */
  readonly subject: string;
  readonly fidelity: Fidelity;
  /** What was written for the item, in plain words. Empty when unsupported. */
  readonly written: readonly string[];
  readonly notes: readonly FieldNote[];
  /** Facts worth knowing that are not differences from the plan. */
  readonly remarks: readonly string[];
}

export interface ExportFile {
  readonly name: string;
  /** "PowerShell", "Terraform (HCL)", "JSON", "Cisco IOS configuration", ... */
  readonly kind: string;
  readonly mime: string;
  readonly text: string;
}

/** Part of the plan the target has nothing to write for (a VLAN with no DHCP pool in a DHCP export). */
export interface Skipped {
  readonly subject: string;
  readonly reason: string;
}

export interface ExportOutput {
  /** False when nothing was generated; `refusals` says why. */
  readonly ok: boolean;
  readonly refusals: readonly string[];
  readonly files: readonly ExportFile[];
  readonly items: readonly ExportItem[];
  readonly skipped: readonly Skipped[];
  /** What the output takes for granted about the platform. */
  readonly assumptions: readonly string[];
  /** What a person still has to do or supply. */
  readonly manualSteps: readonly string[];
  /** Features this target never writes. */
  readonly notCovered: readonly string[];
  /** Rights the generated text needs when someone runs it. Empty when it needs none. */
  readonly privileges: readonly string[];
  readonly counts: Readonly<Record<Fidelity, number>>;
}

/** Collects what was written for one item and what was not. */
export class ItemBuilder {
  private readonly written: string[] = [];
  private readonly notes: FieldNote[] = [];
  private readonly remarks: string[] = [];

  constructor(readonly subject: string) {}

  wrote(what: string): this {
    this.written.push(what);
    return this;
  }

  approximate(field: string, detail: string): this {
    this.notes.push({ fidelity: 'approximate', field, detail });
    return this;
  }

  unsupported(field: string, detail: string): this {
    this.notes.push({ fidelity: 'unsupported', field, detail });
    return this;
  }

  remark(text: string): this {
    this.remarks.push(text);
    return this;
  }

  get wroteAnything(): boolean {
    return this.written.length > 0;
  }

  /** Nothing written is unsupported; anything written with a note is approximate; otherwise exact. */
  build(): ExportItem {
    const fidelity: Fidelity = this.written.length === 0 ? 'unsupported' : this.notes.length > 0 ? 'approximate' : 'exact';
    return { subject: this.subject, fidelity, written: [...this.written], notes: [...this.notes], remarks: [...this.remarks] };
  }
}

export interface OutputParts {
  files?: readonly ExportFile[];
  items?: readonly ExportItem[];
  skipped?: readonly Skipped[];
  assumptions?: readonly string[];
  manualSteps?: readonly string[];
  notCovered?: readonly string[];
  privileges?: readonly string[];
}

export function countItems(items: readonly ExportItem[]): Record<Fidelity, number> {
  const counts: Record<Fidelity, number> = { exact: 0, approximate: 0, unsupported: 0 };
  for (const item of items) counts[item.fidelity]++;
  return counts;
}

export function output(parts: OutputParts): ExportOutput {
  const items = parts.items ?? [];
  return {
    ok: true, refusals: [], files: parts.files ?? [], items, skipped: parts.skipped ?? [],
    assumptions: parts.assumptions ?? [], manualSteps: parts.manualSteps ?? [], notCovered: parts.notCovered ?? [],
    privileges: parts.privileges ?? [], counts: countItems(items),
  };
}

/** Nothing generated. Items and skipped entries may still explain what was looked at. */
export function refused(refusals: readonly string[], parts: OutputParts = {}): ExportOutput {
  const items = parts.items ?? [];
  return {
    ok: false, refusals, files: [], items, skipped: parts.skipped ?? [],
    assumptions: parts.assumptions ?? [], manualSteps: parts.manualSteps ?? [], notCovered: parts.notCovered ?? [],
    privileges: [], counts: countItems(items),
  };
}

/** The whole account as plain text, for copying next to the generated files. */
export function accountText(title: string, o: ExportOutput): string {
  const lines: string[] = [title, ''];
  const list = (heading: string, entries: readonly string[]) => {
    if (entries.length === 0) return;
    lines.push(heading);
    for (const e of entries) lines.push(`- ${e}`);
    lines.push('');
  };
  if (!o.ok) list('Nothing was generated', o.refusals);
  list('Privileges', o.privileges);
  if (o.items.length > 0) {
    lines.push(`Items: ${o.counts.exact} exact, ${o.counts.approximate} approximate, ${o.counts.unsupported} unsupported`);
    for (const item of o.items) {
      lines.push(`- [${FIDELITY_LABEL[item.fidelity]}] ${item.subject}${item.written.length > 0 ? `: ${item.written.join('; ')}` : ''}`);
      for (const n of item.notes) lines.push(`  - [${FIDELITY_LABEL[n.fidelity]}] ${n.field}: ${n.detail}`);
      for (const r of item.remarks) lines.push(`  - ${r}`);
    }
    lines.push('');
  }
  list('Not exported (nothing in the plan for this target)', o.skipped.map(s => `${s.subject}: ${s.reason}`));
  list('Assumptions', o.assumptions);
  list('Manual steps', o.manualSteps);
  list('Not covered by this export', o.notCovered);
  return `${lines.join('\n').trimEnd()}\n`;
}
