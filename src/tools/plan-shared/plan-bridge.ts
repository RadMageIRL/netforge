/**
 * Hands the plan that is open in the planner to the export tools. Memory only: the plan is passed
 * as a copy between two tools of the same page, and is never written to storage or sent anywhere.
 */
import type { Plan } from '../../core/plan/model';

let provider: (() => Plan) | null = null;

/** Called by the planner when it is first opened. */
export function setPlanProvider(p: () => Plan): void {
  provider = p;
}

/** A copy of the planner's current plan, or null when the planner has not been opened in this page. */
export function plannerPlan(): Plan | null {
  return provider ? provider() : null;
}
