import { expect, it } from 'vitest';
import { AgentRepair } from '../../src/agent-repair';
import type { RepairCheck, RepairState } from '../../src/task-evidence';

const check = (changes: Partial<RepairCheck> = {}): RepairCheck => ({ key: 'lint', command: 'npm', args: ['run', 'lint'],
  state: 'failed', generation: 1, attemptId: 'first', fingerprint: 'error-one', blocked: false, ...changes });
const state = (checks: RepairCheck[] = [], changes: Partial<RepairState> = {}): RepairState => ({ generation: 1, mutated: true, checks, diagnosticErrors: false, ...changes });

it('allows a failed check to be repaired and then completed with current passing evidence', () => {
  const repair = new AgentRepair(3);
  repair.observe(state([check()]));
  expect(repair.stopped).toBeUndefined();
  repair.observe(state([check({ attemptId: 'fixed', state: 'passed', fingerprint: 'success', generation: 2 })], { generation: 2 }));
  expect(repair.completion(state([check({ attemptId: 'fixed', state: 'passed', generation: 2 })], { generation: 2 }))).toBeUndefined();
  expect(repair.stopped).toBeUndefined();
});

it('does not let passing lint hide a failed build', () => {
  const repair = new AgentRepair(3);
  const evidence = state([check({ state: 'passed' }), check({ key: 'build', attemptId: 'build', fingerprint: 'compiler-error' })]);
  repair.observe(evidence);
  expect(repair.completion(evidence)).toContain('failed build');
});

for (const limit of [1, 3]) {
  for (const order of [['lint', 'build', 'test'], ['build', 'lint', 'test']]) {
    it.each(['batch', 'separate turns'])('keeps one repair and all rechecks within limit ' + limit + ', order ' + order.join('/') + ', %s', delivery => {
      const repair = new AgentRepair(limit);
      const initial = order.map(script => check({ key: script, args: ['run', script], attemptId: `initial-${script}`,
        state: script === 'lint' ? 'failed' : 'passed', fingerprint: script === 'lint' ? 'lint-error' : 'passed' }));
      const observeSuite = (checks: RepairCheck[], generation: number, previous: RepairCheck[] = []) => {
        if (delivery === 'batch') repair.observe(state(checks, { generation }));
        else for (let i = 0; i < checks.length; i++) {
          repair.observe(state([...checks.slice(0, i + 1), ...previous.slice(i + 1)], { generation }));
          expect(repair.stopped).toBeUndefined();
        }
        expect(repair.stopped).toBeUndefined();
      };
      observeSuite(initial, 1);
      const stale = initial.map(item => ({ ...item, state: 'stale' as const }));
      repair.observe(state(stale, { generation: 2 }));
      expect(repair.stopped).toBeUndefined();
      const passed = initial.map(item => ({ ...item, state: 'passed' as const, generation: 2,
        attemptId: `fixed-${item.key}`, fingerprint: 'passed' }));
      observeSuite(passed, 2, stale);
      expect(repair.completion(state(passed, { generation: 2 }))).toBeUndefined();
      expect(repair.stopped).toBeUndefined();
    });
  }
}

it('stops on two unchanged failure fingerprints despite another edit generation', () => {
  const repair = new AgentRepair(3);
  repair.observe(state([check()]));
  repair.observe(state([check({ attemptId: 'retry', generation: 2 })], { generation: 2 }));
  expect(repair.stopped).toContain('two identical failures');
});

it('bounds changing failures by the repair budget and does not count inspection snapshots', () => {
  const repair = new AgentRepair(1);
  repair.observe(state([check()]));
  for (let i = 0; i < 10; i++) repair.observe(state([check({ state: 'stale' })], { generation: 2 }));
  expect(repair.stopped).toBeUndefined();
  repair.observe(state([check({ attemptId: 'retry', fingerprint: 'different-error', generation: 2 })], { generation: 2 }));
  expect(repair.stopped).toBeUndefined();
  expect(repair.beforeMutation()).toContain('iteration limit (1)');
  expect(repair.stopped).toContain('iteration limit (1)');
});

it('allows exactly three changing repair attempts with the default budget', () => {
  const repair = new AgentRepair(3);
  repair.observe(state([check()]));
  for (let i = 1; i <= 3; i++) {
    expect(repair.beforeMutation()).toBeUndefined();
    repair.observe(state([check({ state: 'stale', attemptId: i === 1 ? 'first' : `retry-${i - 1}`,
      fingerprint: i === 1 ? 'error-one' : `failure-${i - 1}`, generation: i })], { generation: i + 1 }));
    repair.observe(state([check({ attemptId: `retry-${i}`, fingerprint: `failure-${i}`, generation: i + 1 })], { generation: i + 1 }));
    expect(repair.stopped).toBeUndefined();
  }
  expect(repair.beforeMutation()).toContain('iteration limit (3)');
});

it('bounds premature completions when an edited task never verifies', () => {
  const repair = new AgentRepair(1);
  expect(repair.completion(state())).toContain('verification:true');
  expect(repair.completion(state())).toBeUndefined();
  expect(repair.stopped).toContain('iteration limit');
});

it('gives a newly declared missing check its first repair cycle with a limit of one', () => {
  const repair = new AgentRepair(1);
  expect(repair.completion(state([check({ state: 'not_run', attemptId: undefined, fingerprint: undefined })]))).toContain('cycle 1/1');
  expect(repair.stopped).toBeUndefined();
});

it('does not require verification for explanations or read-only exploration', () => {
  const repair = new AgentRepair(3);
  expect(repair.completion(state([], { mutated: false }))).toBeUndefined();
  expect(repair.stopped).toBeUndefined();
});

it('does not continue verification when automatic repair is disabled', () => {
  const repair = new AgentRepair(0);
  repair.observe(state([check()]));
  expect(repair.completion(state([check()]))).toBeUndefined();
  expect(repair.stopped).toBeUndefined();
});

it('stops on an actual blocked command and preserves the first stopping reason', () => {
  const repair = new AgentRepair(3);
  repair.observe(state([check({ state: 'blocked', blocked: true })]));
  expect(repair.stopped).toContain('denied approval');
  repair.stop('different reason');
  expect(repair.stopped).toContain('denied approval');
});

it('does not reset the task-wide budget after a successful repair', () => {
  const repair = new AgentRepair(1);
  repair.observe(state([check()]));
  repair.observe(state([check({ state: 'passed', attemptId: 'passed' })]));
  repair.observe(state([check({ state: 'stale', attemptId: 'passed' })], { generation: 2 }));
  expect(repair.stopped).toBeUndefined();
  repair.observe(state([check({ attemptId: 'later-failure', fingerprint: 'new-error', generation: 2 })], { generation: 2 }));
  expect(repair.stopped).toContain('iteration limit (1)');
});

it('groups multiple repair edits before rechecking into one attempt', () => {
  const repair = new AgentRepair(1);
  repair.observe(state([check()]));
  for (let generation = 2; generation <= 4; generation++) {
    expect(repair.beforeMutation()).toBeUndefined();
    repair.observe(state([check({ state: 'stale' })], { generation }));
  }
  repair.observe(state([check({ state: 'passed', attemptId: 'after-all-edits', generation: 4 })], { generation: 4 }));
  expect(repair.completion(state([check({ state: 'passed', attemptId: 'after-all-edits', generation: 4 })], { generation: 4 }))).toBeUndefined();
  expect(repair.stopped).toBeUndefined();
});

it('prompts once before charging a premature completion against the first repair', () => {
  const repair = new AgentRepair(1);
  repair.observe(state([check()]));
  expect(repair.completion(state([check()]))).toContain('cycle 1/1');
  expect(repair.beforeMutation()).toBeUndefined();
  repair.observe(state([check({ state: 'passed', attemptId: 'repaired', generation: 2 })], { generation: 2 }));
  expect(repair.stopped).toBeUndefined();
});

it('captures the baseline after an initial source edit reports diagnostics', () => {
  const repair = new AgentRepair(1);
  repair.observe(state([], { generation: 1, diagnosticErrors: true }));
  expect(repair.beforeMutation()).toBeUndefined();
  repair.observe(state([], { generation: 2 }));
  repair.observe(state([check({ state: 'passed', attemptId: 'verify-repair', generation: 2 })], { generation: 2 }));
  expect(repair.completion(state([check({ state: 'passed', attemptId: 'verify-repair', generation: 2 })], { generation: 2 }))).toBeUndefined();
  expect(repair.stopped).toBeUndefined();
});
