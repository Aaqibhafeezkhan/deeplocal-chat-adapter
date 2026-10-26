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
  expect(omitted.verification).toBe('failed');
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

const verify = (id: string, executable = 'npm', args = ['run', 'lint']): ToolCall => {
  const invocation = call(id, executable, args);
  invocation.function.arguments = JSON.stringify({ command: executable, args, verification: true });
  return invocation;
};
const edit = (evidence: TaskEvidence, id = 'edit', diagnostics?: { state: 'observed'; newErrors: number; remainingErrors: number }) => {
  evidence.record({ id, type: 'function', function: { name: 'write_file', arguments: '{}' } },
    { callId: id, name: 'write_file', status: 'success', content: 'saved', edit: { path: 'main.ts', saved: true, diagnostics } });
};

it('retains the union of verification calls and valid completion declarations across omissions', () => {
  const evidence = new TaskEvidence();
  evidence.record(verify('lint'), result('lint', command({ exitCode: 1 })));
  evidence.record(call('probe', 'git', ['show', 'missing']), result('probe', command({ exitCode: 128 })));
  evidence.report(finish([{ command: 'npm', args: ['run', 'build'], notRun: 'blocked', reason: 'Build ist gesperrt.' }]));
  const report = evidence.report(finish([]));
  expect(report.checks.map(check => check.state)).toEqual(['failed', 'blocked']);
  expect(report.unverifiedModelText.checkReasons).toEqual([{ command: '["npm","run","build"]', text: 'Build ist gesperrt.' }]);
  expect(report.attempts).toHaveLength(2);
  expect(evidence.repairState().checks[1].blocked).toBe(false); // Model label is not an observed infrastructure block.
  edit(evidence);
  expect(evidence.report(finish([])).checks[0].state).toBe('stale');
});

it('activates earlier exploration attempts only after full declaration validation', () => {
  const evidence = new TaskEvidence(); evidence.record(call('probe'), result('probe', command({ exitCode: 1 })));
  expect(evidence.repairState().checks).toEqual([]);
  expect(evidence.commandRetryBlock(call('retry'))).toBeUndefined();
  expect(() => evidence.report(finish([{ command: 'npm', args: ['run', 'lint'] }, { command: 'bad', args: [], state: 'passed' }]))).toThrow();
  expect(evidence.repairState().checks).toEqual([]);
  evidence.report(finish());
  expect(evidence.repairState().checks[0]).toMatchObject({ state: 'failed', attemptId: 'probe', generation: 0 });
  expect(evidence.commandRetryBlock(call('retry'))).toContain('already failed');
});

it('blocks declined commands permanently and failed checks until mutation, ignoring synthetic suppression', () => {
  const evidence = new TaskEvidence(); evidence.record(verify('fail'), result('fail', command({ truncated: true })));
  expect(evidence.commandRetryBlock(call('again'))).toContain('incomplete');
  evidence.record(call('suppressed'), { callId: 'suppressed', name: 'run_command', status: 'error', content: 'suppressed' }, false);
  expect(evidence.repairState().checks[0]).toMatchObject({ state: 'incomplete', attemptId: 'fail' });
  edit(evidence);
  expect(evidence.commandRetryBlock(call('after-edit'))).toBeUndefined();
  evidence.record(call('denied', 'node', ['test']), { callId: 'denied', name: 'run_command', status: 'declined', content: 'User declined' });
  edit(evidence, 'second-edit');
  expect(evidence.commandRetryBlock(call('retry-denied', 'node', ['test']))).toContain('declined');
  expect(evidence.commandRetryBlock(call('other', 'node', ['other']))).toBeUndefined();
});

it('exposes independent snapshots, current saved diagnostics and real infrastructure blocks', () => {
  const evidence = new TaskEvidence();
  evidence.record(verify('spawn'), result('spawn', command({ exitCode: null, error: { code: 'ENOENT', message: 'Missing' } })));
  const snapshot = evidence.repairState();
  expect(snapshot).toMatchObject({ generation: 0, mutated: false, diagnosticErrors: false, checks: [{ blocked: true, state: 'failed' }] });
  evidence.record(verify('workspace', 'node', []), { callId: 'workspace', name: 'run_command', status: 'error', content: 'Commands require a local workspace folder.' });
  expect(evidence.repairState().checks[1]).toMatchObject({ blocked: true, state: 'failed' });
  snapshot.checks[0].args.push('changed'); snapshot.checks[0].state = 'passed';
  expect(evidence.repairState().checks[0]).toMatchObject({ args: ['run', 'lint'], state: 'failed' });
  edit(evidence, 'errors', { state: 'observed', newErrors: 1, remainingErrors: 0 });
  expect(evidence.repairState()).toMatchObject({ generation: 1, mutated: true, diagnosticErrors: true });
  edit(evidence, 'clear', { state: 'observed', newErrors: 0, remainingErrors: 0 });
  expect(evidence.repairState().diagnosticErrors).toBe(false);
});

it('fingerprints full sanitized evidence stably across generations and durations', () => {
  const evidence = new TaskEvidence();
  evidence.record(verify('first'), result('first', command({ exitCode: 1, stdout: '\u001b[31merror\u001b[0m  \r\nAPI_KEY=firstSecret\r\n', stderr: 'detail  \r\n' })));
  const first = evidence.repairState().checks[0].fingerprint;
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  edit(evidence);
  evidence.record(verify('same'), result('same', command({ exitCode: 1, stdout: 'error\nAPI_KEY=secondSecret\n', stderr: 'detail\n', durationMs: 999 })));
  expect(evidence.repairState().checks[0].fingerprint).toBe(first);
  evidence.record(verify('different'), result('different', command({ exitCode: 1, stdout: 'error\nAPI_KEY=secondSecret\n', stderr: 'different diagnostic' })));
  expect(evidence.repairState().checks[0].fingerprint).not.toBe(first);
  const middle = (text: string) => 'a'.repeat(1000) + text + 'z'.repeat(1000);
  evidence.record(verify('middle1'), result('middle1', command({ stdout: middle('one') })));
  const middle1 = evidence.repairState().checks[0].fingerprint;
  evidence.record(verify('middle2'), result('middle2', command({ stdout: middle('two') })));
  expect(evidence.repairState().checks[0].fingerprint).not.toBe(middle1);
  const complete = evidence.repairState().checks[0].fingerprint;
  evidence.record(verify('limited'), result('limited', command({ stdout: middle('two'), outputLimitExceeded: true })));
  expect(evidence.repairState().checks[0].fingerprint).not.toBe(complete);
});

it('settles saved editor errors only once the full known verification union passes after the edit', () => {
  const evidence = new TaskEvidence();
  evidence.report(finish([{ command: 'npm', args: ['run', 'lint'] }, { command: 'npm', args: ['run', 'build'] }]));
  edit(evidence, 'errors', { state: 'observed', newErrors: 1, remainingErrors: 2 });
  evidence.record(call('lint'), result('lint'));
  expect(evidence.repairState().diagnosticErrors).toBe(true);
  evidence.record(call('build', 'npm', ['run', 'build']), result('build'));
  expect(evidence.repairState().diagnosticErrors).toBe(false);
  edit(evidence, 'next-errors', { state: 'observed', newErrors: 1, remainingErrors: 0 });
  expect(evidence.repairState().diagnosticErrors).toBe(true);
});

it('fails closed when known verification declarations exceed the bounded task cap', () => {
  const evidence = new TaskEvidence();
  const checks = Array.from({ length: 20 }, (_, index) => ({ command: 'npm', args: [String(index)] }));
  evidence.report(finish(checks));
  expect(() => evidence.report(finish([{ command: 'node', args: [] }]))).toThrow(/limit/);
  evidence.record(verify('overflow', 'node', []), result('overflow'));
  expect(evidence.repairState().checks).toHaveLength(20);
  expect(evidence.report().limitation).toContain('limit');
  expect(evidence.report().verification).toBe('unverified');
});

it('normalizes command retries exactly like execution including omitted and coerced arguments', () => {
  const evidence = new TaskEvidence();
  const denied: AgentToolResult = { callId: 'denied', name: 'run_command', status: 'declined', content: 'User declined' };
  evidence.record(call('denied', 'node', []), denied);
  const omitted = call('omitted', 'node'); omitted.function.arguments = JSON.stringify({ command: ' node ' });
  expect(evidence.commandRetryBlock(omitted)).toContain('declined');
  evidence.record(call('number', 'node', ['1', 'null', 'false']), { ...denied, callId: 'number' });
  const coerced = call('coerced'); coerced.function.arguments = JSON.stringify({ command: 'node', args: [1, null, false] });
  expect(evidence.commandRetryBlock(coerced)).toContain('declined');
  evidence.record(verify('fail', 'node', []), result('fail', command({ exitCode: 1 })));
  const failed = call('failed'); failed.function.arguments = JSON.stringify({ command: 'node', args: 'not-an-array' });
  expect(evidence.commandRetryBlock(failed)).toContain('declined');
  const failedOnly = new TaskEvidence();
  failedOnly.record(verify('fail', 'node', []), result('fail', command({ exitCode: 1 })));
  expect(failedOnly.commandRetryBlock(failed)).toContain('already failed');
});

it('blocks denied non-command actions despite reordered JSON without exposing argument content', () => {
  const evidence = new TaskEvidence();
  const write: ToolCall = { id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'file.ts', content: 'privateValue', extra: { z: 1, a: 2 } }) } };
  evidence.record(write, { callId: write.id, name: 'write_file', status: 'declined', content: 'User declined' });
  const retry = { ...write, id: 'retry', function: { ...write.function, arguments: JSON.stringify({ extra: { a: 2, z: 1 }, content: 'privateValue', path: 'file.ts' }) } };
  expect(evidence.commandRetryBlock(retry)).toContain('declined');
  expect(evidence.commandRetryBlock(retry)).not.toContain('privateValue');
  expect(evidence.commandRetryBlock({ ...retry, function: { ...retry.function, arguments: JSON.stringify({ path: 'other.ts', content: 'privateValue' }) } })).toBeUndefined();
  evidence.record(retry, { callId: retry.id, name: 'write_file', status: 'declined', content: 'synthetic' }, false);
  expect(evidence.repairState().generation).toBe(0);
});

it.each([['blocked'], ['skipped'], 1, null, {}])('rejects nonliteral notRun enum values: %j', notRun => {
  const evidence = new TaskEvidence();
  expect(() => evidence.report(finish([{ command: 'npm', args: [], notRun }]))).toThrow();
  expect(evidence.repairState().checks).toEqual([]);
});

it.each([['x'.repeat(513), []], ['node', Array.from({ length: 129 }, () => 'x')], ['node', ['x'.repeat(20001)]]])(
  'fails closed for verification declarations exceeding completion identity bounds', (executable, argv) => {
    const evidence = new TaskEvidence(); evidence.record(verify('oversized', executable as string, argv as string[]), result('oversized'));
    expect(evidence.report().verification).toBe('unverified');
    expect(evidence.report().limitation).toContain('limit');
  });

it('verification:false cannot remove an existing obligation', () => {
  const evidence = new TaskEvidence(); evidence.record(verify('failed'), result('failed', command({ exitCode: 1 })));
  const retry = call('later'); retry.function.arguments = JSON.stringify({ command: 'npm', args: ['run', 'lint'], verification: false });
  expect(evidence.commandRetryBlock(retry)).toContain('already failed');
  evidence.record(retry, { callId: retry.id, name: 'run_command', status: 'error', content: 'suppressed' }, false);
  expect(evidence.report(finish([])).checks[0]).toMatchObject({ state: 'failed', attempts: ['failed', 'later'] });
});
