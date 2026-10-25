import type { RepairState } from './task-evidence';

/** Request-local policy. TaskEvidence remains the authority for command outcomes. */
export class AgentRepair {
  private iterations = 0;
  private active = false;
  private readonly seen = new Set<string>();
  private readonly failures = new Map<string, string>();
  private reason: string | undefined;

  constructor(private readonly limit: number) {}

  get stopped(): string | undefined { return this.reason; }

  stop(reason: string): void { this.reason ??= reason; }

  observe(state: RepairState): void {
    if (this.reason || this.limit === 0) return;
    let attempted = false;
    for (const check of state.checks) {
      if (check.blocked) {
        this.stop('Verification is blocked by a denied approval or unavailable command. No automatic retry was made.');
        return;
      }
      if (!check.attemptId || this.seen.has(check.attemptId)) continue;
      this.seen.add(check.attemptId);
      attempted = true;
      if (check.state === 'passed') this.failures.delete(check.key);
      else if (check.fingerprint) {
        if (this.failures.get(check.key) === check.fingerprint) {
          this.stop('Verification stopped after two identical failures with no observed diagnostic progress.');
          return;
        }
        this.failures.set(check.key, check.fingerprint);
      }
    }
    // A re-verification ends the active cycle; inspection and edits do not.
    if (attempted) this.active = false;
    if (this.needsRepair(state)) this.begin();
    else this.active = false;
  }

  /** A premature completion ends a cycle just as another verification does. */
  completion(state: RepairState): string | undefined {
    const wasActive = this.active;
    const previousIteration = this.iterations;
    this.observe(state);
    if (this.reason || this.limit === 0 || !this.needsRepair(state, true)) return undefined;
    if (wasActive && this.iterations === previousIteration) this.active = false;
    this.begin();
    if (this.reason) return undefined;
    return `Verification is unresolved. Repair cycle ${this.iterations}/${this.limit}: inspect the recorded command output and relevant files, make a targeted fix, then rerun the unresolved checks using run_command with verification:true. Inspect existing project scripts; do not invent commands. Passing lint does not resolve a failed build. If verification cannot run, explain the concrete blocker. Do not repeat a denied action or an identical failed command without a repair.`;
  }

  private needsRepair(state: RepairState, completing = false): boolean {
    return state.diagnosticErrors || state.checks.some(check => !['passed', 'skipped'].includes(check.state))
      || (completing && state.mutated && state.checks.length === 0);
  }

  private begin(): void {
    if (this.active || this.reason) return;
    if (this.iterations >= this.limit) {
      this.stop(`Repair iteration limit (${this.limit}) reached; verification remains incomplete.`);
      return;
    }
    this.iterations++;
    this.active = true;
  }
}
