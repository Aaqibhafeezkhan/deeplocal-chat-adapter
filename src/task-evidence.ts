import type { AgentToolResult } from './agent-tools';
import type { ChatTool, ToolCall } from './protocol';
import { commandSucceeded } from './command-runner';
import { boundedCommandText, redactCommandOutput } from './command-output';
import { parseToolInput } from './tool-input';
import type { DiagnosticObservation } from './edit-validation';

type CheckState = 'passed' | 'failed' | 'incomplete' | 'stale' | 'blocked' | 'skipped' | 'not_run';
interface Attempt {
  id: string;
  tool: string;
  state: CheckState;
  detail: string;
  command?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
  truncated?: boolean;
  outputLimitExceeded?: boolean;
  durationMs?: number;
  saved?: boolean;
  diagnostics?: DiagnosticObservation;
}
export interface CompletionReport {
  verification: 'checks_passed' | 'failed' | 'unverified' | 'interrupted';
  scope: 'Declared commands only; task completeness is not established.';
  notRecorded: 'A requested build, lint or test absent from the recorded attempts is not_run. Undeclared attempts retain their actual outcomes below.';
  checks: Array<{ command: string; state: CheckState; attempts: string[] }>;
  attempts: Attempt[];
  unverifiedModelText: {
    source: 'model';
    verified: false;
    notice: 'Suggestions and stated reasons are not completion evidence.';
    nextSteps: string;
    checkReasons: Array<{ command: string; text: string }>;
  };
  limitation?: string;
}
const clean = (value: string, budget = 1000) => boundedCommandText(redactCommandOutput(value), budget).text;
const commandKey = (command: string, args: string[]) => JSON.stringify([command.trim(), args]);
const displayCommand = (command: string, args: string[]) => {
  const joined = args.join(' ');
  return clean(JSON.stringify([command, ...(redactCommandOutput(joined) === joined ? args : ['[sensitive arguments redacted]'])]));
};
const mutations = new Set(['create_file', 'write_file', 'replace_in_file', 'delete_file']);

export function completionTool(): ChatTool {
  return { type: 'function', function: {
    name: 'submit_completion',
    description: 'Finish an Agent task with evidence, as the only tool call in the turn. List every requested or declared verification command, including checks not run. The host computes states from actual outcomes; never invent results. No free-form success summary. nextSteps is an actionable suggestion in the user’s conversational language, not a verification claim; use an empty string when none is needed.',
    parameters: { type: 'object', additionalProperties: false, required: ['checks', 'nextSteps'], properties: {
      checks: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['command', 'args'], properties: {
        command: { type: 'string', minLength: 1, maxLength: 512 }, args: { type: 'array', maxItems: 128, items: { type: 'string' } },
        callId: { type: 'string', description: 'Optional observed call ID for this exact command, from this task only.' },
        notRun: { type: 'string', enum: ['blocked', 'skipped'] }, reason: { type: 'string', maxLength: 1000 },
      } } }, nextSteps: { type: 'string', maxLength: 2000 },
    } },
  } };
}

/** One send, one pinned workspace. Never reconstructed from model text or old history. */
export class TaskEvidence {
  private readonly observed: Array<{ key?: string; generation: number; fact: Attempt }> = [];
  private generation = 0;
  private readonly ids = new Set<string>();

  reserve(calls: ToolCall[]): void {
    if (calls.length > 32 || this.ids.size + calls.length > 128) throw new Error('Task tool-call limit reached; verification is incomplete.');
    for (const call of calls) {
      if (!call.id || this.ids.has(call.id)) throw new Error('Duplicate or missing task tool-call ID; verification is incomplete.');
      this.ids.add(call.id);
    }
  }

  record(call: ToolCall, result: AgentToolResult, executed = true): void {
    const mutating = mutations.has(call.function.name);
    // A failed write may have applied unsaved changes. Conservatively invalidate
    // earlier checks even when its tool cannot confirm a successful save.
    if (mutating && executed && result.status !== 'declined') this.generation++;
    const fact: Attempt = { id: call.id, tool: call.function.name,
      state: !executed ? 'not_run' : result.status === 'declined' ? 'blocked' : result.status === 'error' ? 'failed' : 'passed',
      detail: clean(result.content, 700),
    };
    let key: string | undefined;
    if (call.function.name === 'run_command') {
      try {
        const args = parseToolInput(call.function.arguments);
        if (typeof args.command === 'string') {
          const argv = Array.isArray(args.args) ? args.args.map(String) : [];
          key = commandKey(args.command, argv);
          fact.command = displayCommand(args.command, argv);
        }
      } catch { /* Malformed tool input is still a recorded failed attempt. */ }
      const command = result.command;
      if (command) {
        fact.state = command.error || (command.exitCode !== null && command.exitCode !== 0) ? 'failed'
          : !commandSucceeded(command) || command.truncated ? 'incomplete' : result.status === 'success' ? 'passed' : 'incomplete';
        Object.assign(fact, { exitCode: command.exitCode, signal: command.signal, timedOut: command.timedOut,
          cancelled: command.cancelled, truncated: command.truncated, outputLimitExceeded: command.outputLimitExceeded, durationMs: command.durationMs });
        fact.detail = JSON.stringify({ stdout: clean(command.stdout, 700), stderr: clean(command.stderr, 700), error: command.error });
      } else if (fact.state === 'passed') fact.state = 'incomplete';
    }
    if (result.edit) {
      fact.saved = result.edit.saved;
      fact.diagnostics = result.edit.diagnostics;
      // Editor diagnostics are observations, never a passed build/test.
      if (fact.state === 'passed') fact.state = 'incomplete';
    }
    this.observed.push({ key, generation: this.generation, fact });
  }

  report(raw?: string, interruption?: string): CompletionReport {
    const input = raw === undefined ? { checks: [], nextSteps: '' } : parseToolInput(raw);
    if (Object.keys(input).some(key => !['checks', 'nextSteps'].includes(key)) || !Array.isArray(input.checks) || input.checks.length > 20
      || typeof input.nextSteps !== 'string' || input.nextSteps.length > 2000) throw new Error('Invalid completion: expected checks and nextSteps.');
    const seen = new Set<string>();
    const checkReasons: CompletionReport['unverifiedModelText']['checkReasons'] = [];
    const checks = input.checks.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid completion check.');
      const check = value as Record<string, unknown>;
      if (Object.keys(check).some(key => !['command', 'args', 'callId', 'notRun', 'reason'].includes(key))
        || typeof check.command !== 'string' || !check.command.trim() || check.command.length > 512
        || !Array.isArray(check.args) || check.args.length > 128 || !check.args.every(arg => typeof arg === 'string')
        || JSON.stringify(check.args).length > 20000 || (check.callId !== undefined && typeof check.callId !== 'string')
        || (check.notRun !== undefined && !['blocked', 'skipped'].includes(String(check.notRun)))
        || (check.reason !== undefined && (typeof check.reason !== 'string' || check.reason.length > 1000))) throw new Error('Invalid completion check fields.');
      const key = commandKey(check.command, check.args);
      if (seen.has(key)) throw new Error('Duplicate completion check.');
      seen.add(key);
      const attempts = this.observed.filter(attempt => attempt.key === key);
      if (check.callId !== undefined && !attempts.some(attempt => attempt.fact.id === check.callId)) throw new Error('Completion references no matching command in this task.');
      const latest = attempts.at(-1);
      const state: CheckState = latest ? latest.generation !== this.generation ? 'stale' : latest.fact.state : (check.notRun as 'blocked' | 'skipped' | undefined) ?? 'not_run';
      const display = displayCommand(check.command, check.args);
      if (!latest && check.reason) checkReasons.push({ command: display, text: clean(String(check.reason)) });
      return { command: display, state, attempts: attempts.map(attempt => attempt.fact.id) };
    });
    const facts = this.observed.map(({ fact }) => ({ ...fact }));
    // No declaration can remove/relabel a failed attempt. checks_passed is scoped
    // to the named commands; the full attempt history is always retained below.
    const verification = interruption ? 'interrupted' : checks.some(check => check.state === 'failed') ? 'failed'
      : checks.length && checks.every(check => check.state === 'passed') ? 'checks_passed' : 'unverified';
    return { verification, scope: 'Declared commands only; task completeness is not established.',
      notRecorded: 'A requested build, lint or test absent from the recorded attempts is not_run. Undeclared attempts retain their actual outcomes below.', checks, attempts: facts,
      // Model prose is preserved for usefulness, but its provenance/trust label
      // must travel with it through display, copy, history and restoration.
      unverifiedModelText: { source: 'model', verified: false, notice: 'Suggestions and stated reasons are not completion evidence.',
        nextSteps: clean(input.nextSteps, 2200), checkReasons },
      ...(interruption ? { limitation: clean(interruption) } : raw === undefined ? { limitation: 'No structured completion was submitted; model success claims were not accepted.' } : {}),
    };
  }
}

export function formatCompletion(report: CompletionReport): string {
  return JSON.stringify(report, null, 2);
}
