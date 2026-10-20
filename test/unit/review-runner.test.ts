import { expect, it, vi } from 'vitest';
import { ChatCompletionRequest, ResponseContext, StreamEvent } from '../../src/protocol';
import { getReviewTools, invokeReviewTool, ReviewRunOptions, ReviewToolSource, runReview } from '../../src/review-runner';
import { responsesBody } from '../../src/responses';

const finding = {
  title: 'Reject zero before division', severity: 'High', classification: 'confirmed',
  explanation: 'A zero divisor returns Infinity to the caller.', evidence: 'return 1 / n;',
  path: 'math.ts', side: 'target', startLine: 1, endLine: 1,
};
const submission = { summary: 'One correctness defect found.', findings: [finding] };

function call(name: string, args: unknown = {}, id = name): StreamEvent {
  return { kind: 'toolCall', value: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } } };
}

function setup(turns: StreamEvent[][] = [[call('submit_review', submission)]]) {
  const source: ReviewToolSource = {
    request: { source: 'staged' }, label: 'Staged changes', limitations: ['Large binary skipped.'],
    diff: 'diff --git a/math.ts b/math.ts\n@@ -1 +1 @@\n-return n;\n+return 1 / n;',
    files: [{ path: 'math.ts', status: 'M', binary: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] }],
    readFile: vi.fn(async () => 'return 1 / n;\n'),
    search: vi.fn(async () => 'math.test.ts:1:test zero input'),
    verifyUnchanged: vi.fn(async () => {}),
  };
  const controller = new AbortController();
  let turn = 0;
  const stream = vi.fn(async function* (_id: string, _request: ChatCompletionRequest) {
    yield* turns[turn++] ?? [];
  });
  const options: ReviewRunOptions = {
    requestId: 'review-1', model: 'test-model', source, focus: 'Check numeric edge cases',
    signal: controller.signal, maxTurns: 3, maxOutputTokens: 2048,
    stream, onProgress: vi.fn(), onTool: vi.fn(),
  };
  return { options, source, controller, stream };
}

it('advertises only the three read-only review tools', () => {
  expect(getReviewTools().map(tool => tool.function.name)).toEqual(['read_review_file', 'search_review_source', 'submit_review']);
});

it('returns a validated report with immutable evidence and host limitations', async () => {
  const { options, source, stream } = setup();
  const report = await runReview(options);
  expect(report).toMatchObject({ summary: submission.summary, findings: [finding],
    testsRun: false, label: source.label, limitations: source.limitations,
    sources: [{ path: 'math.ts', side: 'target', content: 'return 1 / n;\n' }] });
  expect(source.verifyUnchanged).toHaveBeenCalledOnce();
  expect(options.onTool).toHaveBeenCalledWith('submit_review', expect.stringContaining('Tests were not run'));
  const request = stream.mock.calls[0][1];
  expect(request.max_tokens).toBe(2048);
  expect(request.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('untrusted evidence') });
  expect(JSON.parse(request.messages[1].content!)).toMatchObject({
    diff: source.diff, files: source.files, label: source.label, limitations: source.limitations, focus: options.focus,
  });
});

it('accepts an explicitly submitted empty report without inventing a test result', async () => {
  const { options } = setup([[call('submit_review', { summary: 'No actionable findings.', findings: [] })]]);
  expect(await runReview(options)).toMatchObject({ findings: [], testsRun: false });
});

it('reads the selected snapshot side and searches source and tests', async () => {
  const { source } = setup();
  await invokeReviewTool('read_review_file', JSON.stringify({ path: 'math.ts', side: 'base' }), source);
  await invokeReviewTool('read_review_file', JSON.stringify({ path: 'math.test.ts' }), source);
  await invokeReviewTool('search_review_source', JSON.stringify({ query: 'divide' }), source);
  expect(source.readFile).toHaveBeenNthCalledWith(1, 'math.ts', 'base');
  expect(source.readFile).toHaveBeenNthCalledWith(2, 'math.test.ts', 'target');
  expect(source.search).toHaveBeenCalledWith('divide');
});

it.each(['write_file', 'run_command', 'delete_file', 'create_file', 'get_active_file', 'unknown'])
('rejects forbidden %s before dispatching any call in the turn', async name => {
  const { options, source } = setup([[call('read_review_file', { path: 'math.ts' }), call(name)]]);
  await expect(runReview(options)).rejects.toThrow('not permitted');
  expect(source.readFile).not.toHaveBeenCalled();
  expect(source.search).not.toHaveBeenCalled();
  expect(source.verifyUnchanged).not.toHaveBeenCalled();
  await expect(invokeReviewTool(name, '{}', source)).rejects.toThrow('not permitted');
});

it.each([
  ['read_review_file', { path: 'math.ts', side: 'workspace' }],
  ['read_review_file', { path: '' }],
  ['read_review_file', { path: 'math.ts', command: 'write' }],
  ['search_review_source', { query: '' }],
  ['search_review_source', { query: 'test', command: 'write' }],
] as const)('validates %s arguments without calling the source', async (name, args) => {
  const { source } = setup();
  await expect(invokeReviewTool(name, JSON.stringify(args), source)).rejects.toThrow('Invalid');
  expect(source.readFile).not.toHaveBeenCalled();
  expect(source.search).not.toHaveBeenCalled();
});

it('preserves complete Responses assistant/tool groups between turns', async () => {
  const context: ResponseContext = { source: 'remote', model: 'test-model', items: [
    { id: 'r1', type: 'reasoning', encrypted_content: 'opaque' },
    { id: 'f1', type: 'function_call', call_id: 'read', name: 'read_review_file', arguments: '{"path":"math.ts"}' },
    { id: 'f2', type: 'function_call', call_id: 'search', name: 'search_review_source', arguments: '{"query":"test"}' },
  ] };
  const { options, stream } = setup([
    [{ kind: 'text', value: 'Inspecting tests.' }, { kind: 'summary', id: 'r1:0', value: 'Checking edge cases.' },
      { kind: 'responseContext', value: context }, call('read_review_file', { path: 'math.ts' }, 'read'),
      call('search_review_source', { query: 'test' }, 'search')],
    [call('submit_review', submission)],
  ]);
  await runReview(options);
  const request = stream.mock.calls[1][1];
  expect(request.messages.slice(2)).toEqual([
    { role: 'assistant', content: 'Inspecting tests.', responseContext: context,
      tool_calls: [call('read_review_file', { path: 'math.ts' }, 'read'), call('search_review_source', { query: 'test' }, 'search')]
        .map(event => event.kind === 'toolCall' ? event.value : undefined) },
    { role: 'tool', tool_call_id: 'read', name: 'read_review_file', content: 'return 1 / n;\n' },
    { role: 'tool', tool_call_id: 'search', name: 'search_review_source', content: 'math.test.ts:1:test zero input' },
  ]);
  const body = responsesBody(request, 'remote', true);
  expect(body.input.slice(2, 5)).toEqual(context.items);
  expect(body.input.slice(-2).map(item => item.type)).toEqual(['function_call_output', 'function_call_output']);
  expect(options.onProgress).not.toHaveBeenCalledWith('Inspecting tests.');
  expect(options.onProgress).not.toHaveBeenCalledWith('Checking edge cases.');
});

it('rejects a prose-only answer instead of presenting a clean report', async () => {
  const { options, source } = setup([[{ kind: 'text', value: 'No bugs found; all tests pass.' }]]);
  await expect(runReview(options)).rejects.toThrow('did not submit');
  expect(source.verifyUnchanged).not.toHaveBeenCalled();
  expect(options.onTool).not.toHaveBeenCalled();
});

it.each([{ summary: 'Clean' }, { summary: 'Clean', findings: 'none' },
  { ...submission, testsRun: true }, { ...submission, findings: [{ ...finding, startLine: 5, endLine: 5 }] }])
('rejects a malformed terminal report', async payload => {
  const { options, source } = setup([[call('submit_review', payload)]]);
  await expect(runReview(options)).rejects.toThrow('Invalid review');
  expect(source.verifyUnchanged).not.toHaveBeenCalled();
  expect(options.onTool).not.toHaveBeenCalled();
});

it('rejects malformed JSON without echoing the argument payload', async () => {
  const { options } = setup([[{ kind: 'toolCall', value: {
    id: 'submit', type: 'function', function: { name: 'submit_review', arguments: '{"secret":"hidden"' },
  } }]]);
  await expect(runReview(options)).rejects.toThrow('Invalid or incomplete tool arguments');
});

it('requires submit_review to be the sole terminal call', async () => {
  const { options, source } = setup([[call('read_review_file', { path: 'math.ts' }), call('submit_review', submission)]]);
  await expect(runReview(options)).rejects.toThrow('only tool call');
  expect(source.readFile).not.toHaveBeenCalled();
});

it('rejects a changed source snapshot before returning the report', async () => {
  const { options, source } = setup();
  source.verifyUnchanged = vi.fn(async () => { throw new Error('Review snapshot changed.'); });
  await expect(runReview(options)).rejects.toThrow('snapshot changed');
  expect(options.onTool).not.toHaveBeenCalled();
});

it('stops at the configured turn limit without producing a report', async () => {
  const { options, stream, source } = setup([[call('search_review_source', { query: 'test' })]]);
  options.maxTurns = 1;
  await expect(runReview(options)).rejects.toThrow('turn limit');
  expect(stream).toHaveBeenCalledOnce();
  expect(source.verifyUnchanged).not.toHaveBeenCalled();
});

it('rejects invalid turn and output limits before requesting a model', async () => {
  for (const override of [{ maxTurns: 0 }, { maxTurns: Infinity }, { maxTurns: 1001 }, { maxOutputTokens: 0 }]) {
    const { options, stream } = setup();
    await expect(runReview({ ...options, ...override })).rejects.toThrow('limit');
    expect(stream).not.toHaveBeenCalled();
  }
});

it('limits tool calls in a single model turn', async () => {
  const { options, source } = setup([Array.from({ length: 33 }, (_, i) => call('search_review_source', { query: 'test' }, `${i}`))]);
  await expect(runReview(options)).rejects.toThrow('tool-call limit');
  expect(source.search).not.toHaveBeenCalled();
});

it('rejects duplicate call IDs before executing any tools', async () => {
  const { options, source } = setup([[call('search_review_source', { query: 'a' }), call('search_review_source', { query: 'b' })]]);
  await expect(runReview(options)).rejects.toThrow('duplicate');
  expect(source.search).not.toHaveBeenCalled();
});

it('honors cancellation before the model request', async () => {
  const { options, controller, stream } = setup();
  controller.abort();
  await expect(runReview(options)).rejects.toMatchObject({ name: 'AbortError' });
  expect(stream).not.toHaveBeenCalled();
});

it('honors cancellation while streaming before dispatching tools', async () => {
  const { options, controller, source } = setup();
  options.stream = async function* () {
    yield call('read_review_file', { path: 'math.ts' });
    controller.abort();
  };
  await expect(runReview(options)).rejects.toMatchObject({ name: 'AbortError' });
  expect(source.readFile).not.toHaveBeenCalled();
});

it('honors cancellation after a read before dispatching the next tool', async () => {
  const { options, controller, source } = setup([[
    call('read_review_file', { path: 'math.ts' }), call('search_review_source', { query: 'test' }),
  ]]);
  source.readFile = vi.fn(async () => { controller.abort(); return 'return 1 / n;'; });
  await expect(runReview(options)).rejects.toMatchObject({ name: 'AbortError' });
  expect(source.search).not.toHaveBeenCalled();
  expect(options.onTool).not.toHaveBeenCalled();
});

it('honors cancellation while validating findings without returning a report', async () => {
  const { options, controller, source } = setup();
  source.readFile = vi.fn(async () => { controller.abort(); return 'return 1 / n;'; });
  await expect(runReview(options)).rejects.toMatchObject({ name: 'AbortError' });
  expect(source.verifyUnchanged).not.toHaveBeenCalled();
});

it('honors cancellation during final snapshot verification', async () => {
  const { options, controller, source } = setup();
  source.verifyUnchanged = vi.fn(async () => { controller.abort(); });
  await expect(runReview(options)).rejects.toMatchObject({ name: 'AbortError' });
  expect(options.onTool).not.toHaveBeenCalled();
});
