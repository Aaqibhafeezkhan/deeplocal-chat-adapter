import type { RepairState } from './task-evidence';

/** Request-local policy. TaskEvidence remains the authority for command outcomes. */
export class AgentRepair {
  private iterations = 0;
  private active = false;
  private generation = 0;
  private baseline = 0;
  private repaired = false;
  private rechecked = false;
  private prompted = false;
  private readonly seen = new Set<string>();
  private readonly failures = new Map<string, string>();
  private reason: string | undefined;

  constructor(private readonly limit: number) {}

  get stopped(): string | undefined { return this.reason; }

  stop(reason: string): void { this.reason ??= reason; }

  observe(state: RepairState): void {
    if (this.reason || this.limit === 0) return;
    this.generation = state.generation;
    if (this.active && state.generation !== this.baseline) this.repaired = true;
    for (const check of state.checks) {
      if (check.blocked) {
        this.stop('Verification is blocked by a denied approval or unavailable command. No automatic retry was made.');
        return;
      }
      if (!check.attemptId || this.seen.has(check.attemptId)) continue;
      this.seen.add(check.attemptId);
      if (this.active && this.repaired && check.generation === state.generation) this.rechecked = true;
      if (check.state === 'passed') this.failures.delete(check.key);
      else if (check.fingerprint && ['failed', 'incomplete'].includes(check.state)) {
        if (this.failures.get(check.key) === check.fingerprint) {
          this.stop('Verification stopped after two identical failures with no observed diagnostic progress.');
          return;
        }
        this.failures.set(check.key, check.fingerprint);
      }
    }
    // One repair can need several checks, even when they arrive in separate
    // turns. Results alone never consume another attempt.
    if (!this.needsRepair(state, this.active)) this.active = false;
    else if (!this.active && (state.diagnosticErrors || state.checks.some(check => ['failed', 'incomplete'].includes(check.state)))) this.begin();
  }

  /** Enforce the next repair allowance before a write or its approval can run. */
  beforeMutation(): string | undefined {
    if (this.active && this.repaired && this.rechecked) this.next();
    return this.reason;
  }

  /** Prompt once within an attempt; repeated premature completions are bounded. */
  completion(state: RepairState): string | undefined {
    this.observe(state);
    if (this.reason || this.limit === 0 || !this.needsRepair(state, true)) return undefined;
    if (this.active && (this.prompted || (this.repaired && this.rechecked))) this.next();
    else this.begin();
    if (this.reason) return undefined;
    this.prompted = true;
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
    this.baseline = this.generation;
    this.repaired = false;
    this.rechecked = false;
    this.prompted = false;
  }

  private next(): void {
    this.active = false;
    this.begin();
  }
}
