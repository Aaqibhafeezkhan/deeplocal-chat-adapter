import { beforeEach, expect, it, vi } from 'vitest';
import { ChatPanel } from '../../src/chat-panel';
import { ReviewReport } from '../../src/review-types';

const env = vi.hoisted(() => ({
  git: vi.fn(), run: vi.fn(), confirm: vi.fn(), show: vi.fn(), clipboard: vi.fn(),
  folders: [{ name: 'project', index: 0, uri: { scheme: 'file', fsPath: '/project', toString: () => 'file:///project' } }],
  foldersChanged: (_event: unknown) => {},
  providers: new Map<string, { provideTextDocumentContent: (uri: { toString: () => string }) => string }>(),
  config: { approvalMode: 'full', agentMaxTurns: 3, maxOutputTokens: 1000 },
}));

vi.mock('../../src/review-git', () => ({ createGitReview: env.git }));
vi.mock('../../src/review-runner', () => ({ runReview: env.run }));
vi.mock('../../src/config', () => ({ getConfig: () => env.config }));
vi.mock('vscode', () => ({
  env: { clipboard: { writeText: env.clipboard } },
  Uri: { parse: (value: string) => ({ scheme: value.split(':')[0], toString: () => value }) },
  Range: class { constructor(public startLine: number, public startCharacter: number, public endLine: number, public endCharacter: number) {} },
  window: { showWarningMessage: env.confirm, showTextDocument: env.show },
  workspace: {
    get workspaceFolders() { return env.folders; },
    onDidChangeWorkspaceFolders: (callback: typeof env.foldersChanged) => { env.foldersChanged = callback; return { dispose: vi.fn() }; },
    registerTextDocumentContentProvider: (scheme: string, provider: { provideTextDocumentContent: (uri: { toString: () => string }) => string }) => {
      env.providers.set(scheme, provider); return { dispose: vi.fn() };
    },
    openTextDocument: async (uri: { scheme: string; toString: () => string }) => ({ uri, getText: () => env.providers.get(uri.scheme)?.provideTextDocumentContent(uri) }),
  },
}));

const report: ReviewReport = {
  summary: 'One defect found.', label: 'Staged changes', testsRun: false, limitations: [],
  sources: [{ path: 'old.ts', side: 'base', content: 'reviewed historical content\n' }],
  findings: [{ title: 'Lost validation', severity: 'High', classification: 'confirmed', explanation: 'The deleted validation is required.',
    evidence: 'reviewed historical content', path: 'old.ts', side: 'base', startLine: 1, endLine: 1 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  env.providers.clear();
  env.folders = [{ name: 'project', index: 0, uri: { scheme: 'file', fsPath: '/project', toString: () => 'file:///project' } }];
  env.git.mockResolvedValue({ files: [{ path: 'file.ts' }], label: 'Staged changes' });
  env.run.mockResolvedValue(report);
  env.config.approvalMode = 'full';
});

function harness() {
  const state = new Map<string, unknown>();
  const memento = { get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
    update: async (key: string, value: unknown) => { state.set(key, structuredClone(value)); } };
  const sent: Array<Record<string, unknown>> = [];
  let receive = (_message: unknown) => {};
  const client = { modelInformation: vi.fn(() => ({ toolCalling: true })), listModels: async () => [], streamChat: vi.fn(), cancel: vi.fn() };
  const context = { subscriptions: [], workspaceState: memento, globalState: memento };
  const panel = new ChatPanel(context as never, client as never, { error: vi.fn() } as never,
    { get: async () => '', set: async () => {}, clear: async () => {} });
  panel.resolveWebviewView({ webview: { html: '', options: {}, cspSource: 'test:', postMessage: (message: Record<string, unknown>) => sent.push(message),
    onDidReceiveMessage: (callback: typeof receive) => { receive = callback; } }, onDidDispose: () => {} } as never);
  return { state, sent, client, send: (message: unknown) => receive(message) };
}

async function reviewMode(h: ReturnType<typeof harness>) {
  h.send({ type: 'setWorkflow', workflow: 'review' });
  await vi.waitFor(() => expect(h.sent.at(-1)).toEqual({ type: 'workflow', workflow: 'review' }));
}

it('reviews an optional prompt with the selected source and isolated history, even under full access', async () => {
  const h = harness();
  await reviewMode(h);
  h.send({ type: 'send', text: '', model: 'test', useAgent: true, review: { source: 'commits', base: 'v1', target: 'v2' } });
  await vi.waitFor(() => expect(h.sent).toContainEqual({ type: 'assistantDone', outcome: 'success', review: true }));
  expect(env.git).toHaveBeenCalledWith('/project', { source: 'commits', base: 'v1', target: 'v2' }, expect.any(AbortSignal));
  expect(env.run.mock.calls[0][0]).toMatchObject({ focus: '', maxTurns: 3, model: 'test' });
  expect(h.client.streamChat).not.toHaveBeenCalled();
  const sessions = [...h.state.values()].find(Array.isArray) as Array<{ history: unknown[]; transcript: Array<{ reviewReport?: ReviewReport }> }>;
  expect(sessions[0].history).toEqual([]);
  expect(h.sent.filter(message => message.type === 'sessions').at(-1)).toMatchObject({
    sessions: [{ preview: 'Review commit range' }],
  });
  expect(sessions[0].transcript.at(-1)?.reviewReport).toEqual(report);
  h.send({ type: 'ready' });
  await vi.waitFor(() => expect(h.sent.some(message => message.type === 'restore')).toBe(true));
  const restored = h.sent.find(message => message.type === 'restore')!;
  expect(restored.items).toEqual(sessions[0].transcript);
});

it('requires confirmation to leave review and rejects normal sends while confirmation is pending', async () => {
  const h = harness();
  await reviewMode(h);
  let finish!: (value: unknown) => void;
  env.confirm.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  h.send({ type: 'setWorkflow', workflow: 'normal' });
  h.send({ type: 'send', model: 'test', text: 'Modify files', useAgent: true });
  expect(h.client.streamChat).not.toHaveBeenCalled();
  expect(env.git).not.toHaveBeenCalled();
  finish(undefined);
  await vi.waitFor(() => expect(h.sent.at(-1)).toEqual({ type: 'workflow', workflow: 'review' }));
  env.confirm.mockResolvedValueOnce('Enable normal mode');
  h.send({ type: 'setWorkflow', workflow: 'normal' });
  await vi.waitFor(() => expect(h.sent.at(-1)).toEqual({ type: 'workflow', workflow: 'normal' }));
});

it('reports no changes without requesting a model review', async () => {
  const h = harness();
  await reviewMode(h);
  env.git.mockResolvedValueOnce({ files: [], limitations: [] });
  h.send({ type: 'send', model: 'test', review: { source: 'staged' } });
  await vi.waitFor(() => expect(h.sent).toContainEqual({ type: 'assistantDone', outcome: 'success', review: true }));
  expect(env.run).not.toHaveBeenCalled();
  expect(h.sent.find(message => message.type === 'assistantFinal')?.text).toContain('No staged changes');
});

it('keeps review active when starting, switching, or deleting sessions', async () => {
  const h = harness();
  h.send({ type: 'ready' });
  await vi.waitFor(() => expect(h.sent.some(message => message.type === 'sessions')).toBe(true));
  const original = h.sent.find(message => message.type === 'sessions')!.activeSessionId;
  h.send({ type: 'newSession' });
  await vi.waitFor(() => expect(h.sent.filter(message => message.type === 'restore')).toHaveLength(2));
  await reviewMode(h);
  h.send({ type: 'newSession' });
  await vi.waitFor(() => expect(h.sent.filter(message => message.type === 'restore')).toHaveLength(3));
  expect(h.sent.filter(message => message.type === 'workflow').at(-1)).toEqual({ type: 'workflow', workflow: 'review' });
  h.send({ type: 'switchSession', sessionId: original });
  await vi.waitFor(() => expect(h.sent.filter(message => message.type === 'restore')).toHaveLength(4));
  expect(h.sent.filter(message => message.type === 'workflow').at(-1)).toEqual({ type: 'workflow', workflow: 'review' });
  env.confirm.mockResolvedValueOnce('Delete');
  h.send({ type: 'deleteSession', sessionId: original });
  await vi.waitFor(() => expect(h.sent.filter(message => message.type === 'restore')).toHaveLength(5));
  expect(h.sent.filter(message => message.type === 'workflow').at(-1)).toEqual({ type: 'workflow', workflow: 'review' });
  expect(h.client.streamChat).not.toHaveBeenCalled();
});

it.each(['every', 'safe', 'full', 'ask'])('runs the same isolated review under %s permission mode', async permission => {
  env.config.approvalMode = permission;
  const h = harness();
  await reviewMode(h);
  h.send({ type: 'send', model: 'test', review: { source: 'unstaged' } });
  await vi.waitFor(() => expect(env.run).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(h.sent).toContainEqual({ type: 'assistantDone', outcome: 'success', review: true }));
  expect(h.client.streamChat).not.toHaveBeenCalled();
});

it('does not publish a report when evidence validation fails', async () => {
  const h = harness();
  await reviewMode(h);
  env.run.mockRejectedValueOnce(new Error('Invalid review evidence'));
  h.send({ type: 'send', model: 'test' });
  await vi.waitFor(() => expect(h.sent).toContainEqual({ type: 'assistantDone', outcome: 'error', review: true }));
  expect(h.sent.some(message => message.type === 'reviewResult' || message.type === 'assistantFinal')).toBe(false);
  expect(h.sent).toContainEqual({ type: 'error', message: 'Review failed: Invalid review evidence' });
});

it('cancels review collection without publishing a successful report', async () => {
  const h = harness();
  await reviewMode(h);
  env.git.mockImplementationOnce((_root, _request, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  }));
  h.send({ type: 'send', model: 'test' });
  await vi.waitFor(() => expect(env.git).toHaveBeenCalledOnce());
  h.send({ type: 'stop' });
  await vi.waitFor(() => expect(h.sent).toContainEqual({ type: 'assistantDone', outcome: 'cancelled', review: true }));
  expect(h.client.cancel).toHaveBeenCalledOnce();
  expect(env.run).not.toHaveBeenCalled();
});

it('copies only the stored report and opens its historical snapshot through a read-only provider', async () => {
  const h = harness();
  await reviewMode(h);
  h.send({ type: 'send', model: 'test' });
  await vi.waitFor(() => expect(h.sent).toContainEqual({ type: 'assistantDone', outcome: 'success', review: true }));
  const reportId = h.sent.find(message => message.type === 'reviewResult')!.id;
  h.send({ type: 'copyReview', reportId, requestId: 'copy1', text: 'forged summary' });
  await vi.waitFor(() => expect(h.sent).toContainEqual({ type: 'copyResult', requestId: 'copy1', success: true }));
  expect(env.clipboard.mock.calls[0][0]).toContain('Tests were not run');
  expect(env.clipboard.mock.calls[0][0]).not.toContain('forged summary');
  h.send({ type: 'openReviewReference', reportId, findingIndex: 0 });
  await vi.waitFor(() => expect(env.show).toHaveBeenCalledOnce());
  expect(env.show.mock.calls[0][0].getText()).toBe('reviewed historical content\n');
  h.send({ type: 'openReviewReference', reportId, findingIndex: 0 });
  await vi.waitFor(() => expect(env.show).toHaveBeenCalledTimes(2));
  expect(env.providers.size).toBe(1);
  expect(env.show.mock.calls[1][0].getText()).toBe('reviewed historical content\n');
  h.send({ type: 'openReviewReference', reportId, findingIndex: 200 });
  h.send({ type: 'openReviewReference', reportId: 'forged', findingIndex: 0 });
  expect(env.show).toHaveBeenCalledTimes(2);
});
