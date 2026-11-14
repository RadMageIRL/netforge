/**
 * The planner's state: one plan in memory, its validation, and a revision counter. Nothing here is
 * written to storage; a reload starts with an empty plan. Views subscribe and update only what
 * changed. Typing is validated after a short pause; every other change is validated at once.
 */
import { emptyPlan, type Plan } from '../../core/plan/model';
import { validatePlan, type PlanValidation } from '../../core/plan/validate';

export type ChangeSource = 'editor' | 'structure' | 'replace' | 'allocate' | 'other';
export type Listener = (source: ChangeSource) => void;

export class PlanStore {
  plan: Plan;
  validation: PlanValidation;
  revision = 0;
  savedRevision = 0;
  /** Milliseconds the last validation took, for the performance readout. */
  lastValidationMs = 0;
  private readonly listeners: Listener[] = [];
  private timer = 0;
  private pending: ChangeSource | null = null;

  constructor(plan: Plan = emptyPlan()) {
    this.plan = plan;
    this.validation = validatePlan(plan);
  }

  get dirty(): boolean {
    return this.revision !== this.savedRevision && (this.plan.vlans.length > 0 || this.revision > 0);
  }

  subscribe(listener: Listener): void {
    this.listeners.push(listener);
  }

  /** Changes the plan in place. Editor changes (typing) are validated after a pause. */
  change(source: ChangeSource, mutate: (plan: Plan) => void): void {
    mutate(this.plan);
    this.revision++;
    this.pending = this.pending === null || this.pending === source ? source : 'other';
    window.clearTimeout(this.timer);
    if (source === 'editor') this.timer = window.setTimeout(() => this.flush(), 150);
    else this.flush();
  }

  /** Replaces the whole plan (new, open, example, apply allocation). */
  replace(plan: Plan, source: ChangeSource = 'replace', saved = false): void {
    this.plan = plan;
    this.revision++;
    if (saved) this.savedRevision = this.revision;
    this.pending = source;
    window.clearTimeout(this.timer);
    this.flush();
  }

  markSaved(): void {
    this.savedRevision = this.revision;
  }

  /** Runs any pending validation now and tells every view. */
  flush(): void {
    window.clearTimeout(this.timer);
    const source = this.pending ?? 'other';
    this.pending = null;
    const start = performance.now();
    this.validation = validatePlan(this.plan);
    this.lastValidationMs = performance.now() - start;
    for (const l of this.listeners) l(source);
  }
}
