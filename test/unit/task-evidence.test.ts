import { expect, it } from 'vitest';
import { TaskEvidence, formatCompletion } from '../../src/task-evidence';
import type { AgentToolResult } from '../../src/agent-tools';
import type { CommandResult } from '../../src/command-runner';
import type { ToolCall } from '../../src/protocol';

const call = (id: string, command = 'npm', args = ['run', 'lint']): ToolCall => ({ id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command, args }) } });
const command = (changes: Partial<CommandResult> = {}): CommandResult => ({ command: 'npm', args: ['run', 'lint'], cwd: '/synthetic',
  exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 2, timedOut: false, cancelled: false, outputLimitExceeded: false, truncated: false, error: null, ...changes });
const result = (id: string, data = command()): AgentToolResult => ({ callId: id, name: 'run_command', status: data.exitCode === 0 ? 'success' : 'error', content: JSON.stringify(data), command: data });
const finish = (checks: unknown[] = [{ command: 'npm', args: ['run', 'lint'] }], nextSteps = '') => JSON.stringify({ checks, nextSteps });

it('reports failed checks and retains failures omitted from declarations', () => {
  const evidence = new TaskEvidence();
  evidence.record(call('lint'), result('lint', command({ exitCode: 1, stderr: 'src/main.ts:8 lint error' })));
  expect(evidence.report(finish()).verification).toBe('failed');
  const omitted = evidence.report(finish([]));
  expect(omitted.verification).toBe('unverified');
  expect(omitted.attempts[0]).toMatchObject({ state: 'failed', exitCode: 1 });
  expect(omitted.attempts[0].detail).toContain('src/main.ts:8');
});

it('never lets declared skipped/blocked labels override an executed failure', () => {
  const evidence = new TaskEvidence(); evidence.record(call('lint'), result('lint', command({ exitCode: 1 })));
  expect(evidence.report(finish([{ command: 'npm', args: ['run', 'lint'], notRun: 'skipped' }])).checks[0].state).toBe('failed');
});

it('shows a declared build that never executed as not run, without inventing other checks', () => {
  const evidence = new TaskEvidence(); evidence.record(call('lint'), result('lint'));
  const report = evidence.report(finish([{ command: 'npm', args: ['run', 'lint'] }, { command: 'npm', args: ['run', 'build'] }]));
  expect(report.verification).toBe('unverified');
  expect(report.checks.map(check => check.state)).toEqual(['passed', 'not_run']);
  expect(report.checks).toHaveLength(2);
  const omitted = evidence.report(finish());
  expect(omitted.notRecorded).toContain('absent from the recorded attempts is not_run');
});

it.each(['blocked', 'skipped'])('records explicitly %s checks and their bounded reason', notRun => {
  const report = new TaskEvidence().report(finish([{ command: 'npm', args: ['test'], notRun, reason: 'Noch keine Freigabe.' }]));
  expect(report.checks[0]).toMatchObject({ state: notRun, attempts: [] });
  expect(report.unverifiedModelText).toMatchObject({ source: 'model', verified: false, checkReasons: [{ text: 'Noch keine Freigabe.' }] });
  expect(report.verification).toBe('unverified');
});

it.each([
  { exitCode: null }, { exitCode: null, signal: 'SIGTERM' as const }, { timedOut: true }, { cancelled: true },
  { truncated: true }, { outputLimitExceeded: true },
])('fails closed for incomplete command evidence %j', changes => {
  const evidence = new TaskEvidence(); evidence.record(call('lint'), result('lint', command(changes)));
  expect(evidence.report(finish()).checks[0].state).toBe('incomplete');
  expect(evidence.report(finish()).verification).toBe('unverified');
});

it('does not parse a legacy string or a generic successful tool result as command evidence', () => {
  const evidence = new TaskEvidence(); evidence.record(call('lint'), { callId: 'lint', name: 'run_command', status: 'success', content: 'All tests passed' });
  expect(evidence.report(finish()).checks[0].state).toBe('incomplete');
});

it('retains retry history, uses only the latest exact command, and invalidates checks after edits', () => {
  const evidence = new TaskEvidence(); evidence.record(call('one'), result('one', command({ exitCode: 1 })));
  evidence.record(call('two'), result('two'));
  let report = evidence.report(finish()); expect(report.verification).toBe('checks_passed');
  expect(report.checks[0].attempts).toEqual(['one', 'two']);
  expect(report.attempts.map(attempt => attempt.state)).toEqual(['failed', 'passed']);
  evidence.record({ id: 'edit', type: 'function', function: { name: 'write_file', arguments: '{}' } }, { callId: 'edit', name: 'write_file', status: 'success', content: 'Saved', edit: { path: 'main.ts', saved: true, diagnostics: { state: 'inconclusive', newErrors: null, remainingErrors: null } } });
  report = evidence.report(finish()); expect(report.checks[0].state).toBe('stale');
  evidence.record(call('three'), result('three')); expect(evidence.report(finish()).verification).toBe('checks_passed');
  expect(evidence.report(finish()).attempts[2]).toMatchObject({ saved: true, state: 'incomplete', diagnostics: { state: 'inconclusive' } });
  evidence.record(call('four', 'npm', ['run', 'build']), result('four'));
  expect(evidence.report(finish()).checks[0].attempts).toEqual(['one', 'two', 'three']);
});

it('keeps exploration failures visible without calling every command a verification check', () => {
  const evidence = new TaskEvidence(); evidence.record(call('probe', 'git', ['show', 'missing']), result('probe', command({ exitCode: 128 })));
  evidence.record(call('lint'), result('lint'));
  const report = evidence.report(finish()); expect(report.verification).toBe('checks_passed');
  expect(report.scope).toContain('task completeness is not established');
  expect(report.attempts[0].state).toBe('failed'); expect(report.checks).toHaveLength(1);
});

it('uses a failed latest retry even when the model references an older passing attempt', () => {
  const evidence = new TaskEvidence(); evidence.record(call('old-pass'), result('old-pass'));
  evidence.record(call('new-fail'), result('new-fail', command({ exitCode: 2 })));
  const report = evidence.report(finish([{ command: 'npm', args: ['run', 'lint'], callId: 'old-pass' }]));
  expect(report.verification).toBe('failed'); expect(report.checks[0].state).toBe('failed');
  expect(report.checks[0].attempts).toEqual(['old-pass', 'new-fail']);
});

it('retains ordinary tool failures, startup errors and saved diagnostics without using prose as authority', () => {
  const evidence = new TaskEvidence();
  evidence.record({ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    { callId: 'read', name: 'read_file', status: 'error', content: 'File unavailable' });
  evidence.record(call('spawn'), result('spawn', command({ exitCode: null, error: { code: 'ENOENT', message: 'No executable' } })));
  expect(evidence.report(finish()).attempts.map(attempt => attempt.state)).toEqual(['failed', 'failed']);
  expect(evidence.report(finish()).verification).toBe('failed');
});

it('rejects fabricated IDs, different command references, status injection and duplicate declarations', () => {
  const evidence = new TaskEvidence(); evidence.record(call('lint'), result('lint'));
  for (const checks of [
    [{ command: 'npm', args: ['run', 'lint'], callId: 'fabricated' }],
    [{ command: 'npm', args: ['run', 'build'], callId: 'lint' }],
    [{ command: 'npm', args: ['run', 'lint'], state: 'passed' }],
    [{ command: 'npm', args: [] }, { command: 'npm', args: [] }],
  ]) expect(() => evidence.report(finish(checks))).toThrow();
});

it('resets task evidence rather than importing previous session/workspace results', () => {
  const previous = new TaskEvidence(); previous.record(call('old'), result('old'));
  expect(new TaskEvidence().report(finish()).checks[0].state).toBe('not_run');
  expect(() => new TaskEvidence().report(finish([{ command: 'npm', args: ['run', 'lint'], callId: 'old' }]))).toThrow();
});

it('records denied/unexecuted tools and partial interruption without converting them to success', () => {
  const evidence = new TaskEvidence(); evidence.record(call('denied'), { callId: 'denied', name: 'run_command', status: 'declined', content: 'User declined command execution.' });
  expect(evidence.report(finish()).checks[0].state).toBe('blocked');
  evidence.record(call('skipped', 'npm', ['test']), { callId: 'skipped', name: 'run_command', status: 'error', content: 'Task stopped; tool was not executed.' }, false);
  const report = evidence.report(undefined, 'Task stopped'); expect(report.verification).toBe('interrupted');
  expect(report.attempts.map(attempt => attempt.state)).toEqual(['blocked', 'not_run']);
});

it('bounds/redacts report metadata and preserves user-language suggestions without translating commands', () => {
  const evidence = new TaskEvidence(); const args = ['--token', 'syntheticCredential82'];
  evidence.record(call('private', 'node', args), result('private', command({ args: ['[sensitive arguments redacted]'], stdout: 'API_KEY=syntheticCredential82\n' })));
  const report = evidence.report(finish([{ command: 'node', args }], 'Bitte zuerst den Build ausführen.'));
  expect(formatCompletion(report)).not.toContain('syntheticCredential82');
  expect(report.unverifiedModelText.nextSteps).toBe('Bitte zuerst den Build ausführen.'); expect(report.checks[0].command).toContain('node');
});

it('rejects duplicate calls before a batch executes and bounds task evidence', () => {
  const evidence = new TaskEvidence(); expect(() => evidence.reserve([call('one'), call('one')])).toThrow();
  expect(() => new TaskEvidence().reserve(Array.from({ length: 33 }, (_, i) => call(String(i))))).toThrow();
});
