import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { beginEditValidation } from '../../src/edit-validation';

const env = vi.hoisted(() => ({
  diagnostics: [] as [vscode.Uri, vscode.Diagnostic[]][],
  folders: [] as vscode.WorkspaceFolder[],
  diagnosticListeners: new Set<(event: vscode.DiagnosticChangeEvent) => void>(),
  folderListeners: new Set<() => void>(),
  documentListeners: new Set<(event: vscode.TextDocumentChangeEvent) => void>(),
  getDiagnostics: vi.fn(),
}));

vi.mock('vscode', () => ({
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  languages: {
    getDiagnostics: env.getDiagnostics,
    onDidChangeDiagnostics: (listener: (event: vscode.DiagnosticChangeEvent) => void) => {
      env.diagnosticListeners.add(listener);
      return { dispose: () => env.diagnosticListeners.delete(listener) };
    },
  },
  workspace: {
    get workspaceFolders() { return env.folders; },
    onDidChangeWorkspaceFolders: (listener: () => void) => {
      env.folderListeners.add(listener);
      return { dispose: () => env.folderListeners.delete(listener) };
    },
    onDidChangeTextDocument: (listener: (event: vscode.TextDocumentChangeEvent) => void) => {
      env.documentListeners.add(listener);
      return { dispose: () => env.documentListeners.delete(listener) };
    },
  },
}));

function uri(fsPath: string): vscode.Uri {
  return { fsPath, scheme: 'file', authority: '', toString: () => `file://${fsPath}` } as vscode.Uri;
}
const edited = uri('/project/main.ts');
const dependent = uri('/project/dependent.ts');
const folder = { name: 'project', uri: uri('/project'), index: 0 } as vscode.WorkspaceFolder;
let document: vscode.TextDocument;

function diagnostic(message: string, severity = 0, line = 0, code: vscode.Diagnostic['code'] = 2300): vscode.Diagnostic {
  return { message, severity, source: 'ts', code, range: { start: { line, character: 0 }, end: { line, character: 1 } } } as vscode.Diagnostic;
}

function update(uris = [edited]): void {
  for (const listener of env.diagnosticListeners) listener({ uris });
}

function expectClean(): void {
  expect(env.diagnosticListeners.size).toBe(0);
  expect(env.folderListeners.size).toBe(0);
  expect(env.documentListeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  env.diagnostics = [];
  env.folders = [folder];
  env.getDiagnostics.mockImplementation(() => env.diagnostics);
  document = { uri: edited, version: 2, isDirty: false, isClosed: false } as vscode.TextDocument;
});

afterEach(() => {
  expectClean();
  vi.useRealTimers();
});

it('reports new errors even when the lint warning was resolved, including dependent files', async () => {
  env.diagnostics = [[edited, [diagnostic('Use type import', 1)]]];
  const validation = beginEditValidation(folder, edited);
  const pending = validation.finish(document);
  env.diagnostics = [[dependent, [diagnostic('Cannot use type-only import as a value')]]];
  update([edited, dependent]);
  await vi.advanceTimersByTimeAsync(250);
  const result = await pending;
  expect(result.status).toBe('error');
  expect(result.content).toContain('new: 1 errors, 0 warnings');
  expect(result.content).toContain('resolved: 0 errors, 1 warnings');
  expect(result.content).toContain('dependent.ts:1:1');
  expect(result.content).toContain('saved and retained');
});

it('copies the baseline and ignores line shifts while comparing occurrence counts', async () => {
  const original = diagnostic('Duplicate name');
  env.diagnostics = [[edited, [original]]];
  const validation = beginEditValidation(folder, edited);
  Object.assign(original.range.start, { line: 10 });
  env.diagnostics = [[edited, [diagnostic('Duplicate name', 0, 10), diagnostic('Duplicate name', 0, 11)]]];
  const pending = validation.finish(document);
  update();
  await vi.advanceTimersByTimeAsync(250);
  const result = await pending;
  expect(result.status).toBe('error');
  expect(result.content).toContain('new: 1 errors');
  expect(result.content).toContain('remaining: 1 errors');
  expect(result.content).toContain('main.ts:12:1');
});

it('keeps unchanged existing errors separate without failing the operation', async () => {
  env.diagnostics = [[edited, [diagnostic('Existing error')]]];
  const validation = beginEditValidation(folder, edited);
  env.diagnostics = [[edited, [diagnostic('Existing error', 0, 50)]]];
  update(); // A diagnostic event can arrive during application or save, before finish.
  const pending = validation.finish(document);
  await vi.advanceTimersByTimeAsync(250);
  const result = await pending;
  expect(result.status).toBe('success');
  expect(result.content).toContain('new: 0 errors');
  expect(result.content).toContain('Existing errors remain');
  expect(result.content).toContain('not proof of successful compilation');
});

it('normalizes object diagnostic codes and reports severity escalation', async () => {
  env.diagnostics = [[edited, [diagnostic('Problem', 1, 0, { value: 2300, target: edited })]]];
  const validation = beginEditValidation(folder, edited);
  env.diagnostics = [[edited, [diagnostic('Problem', 0, 0, 2300)]]];
  const pending = validation.finish(document);
  update();
  await vi.advanceTimersByTimeAsync(250);
  const result = await pending;
  expect(result.content).toContain('new: 1 errors');
  expect(result.content).toContain('resolved: 0 errors, 1 warnings');
});

it('treats equivalent object and numeric codes as the same diagnostic', async () => {
  env.diagnostics = [[edited, [diagnostic('Problem', 1, 0, { value: 2300, target: edited })]]];
  const validation = beginEditValidation(folder, edited);
  env.diagnostics = [[edited, [diagnostic('Problem', 1, 20, 2300)]]];
  const pending = validation.finish(document);
  update();
  await vi.advanceTimersByTimeAsync(250);
  expect((await pending).content).toContain('remaining: 0 errors, 1 warnings');
});

it('retains original locations in a resolved diagnostic despite provider mutation', async () => {
  const original = diagnostic('Original warning', 1, 4);
  env.diagnostics = [[edited, [original]]];
  const validation = beginEditValidation(folder, edited);
  Object.assign(original.range.start, { line: 99 });
  env.diagnostics = [];
  const pending = validation.finish(document);
  update();
  await vi.advanceTimersByTimeAsync(250);
  expect((await pending).content).toContain('resolved warning: main.ts:5:1');
});

it('requires a full quiet window after the most recent workspace diagnostic update', async () => {
  const validation = beginEditValidation(folder, edited);
  let settled = false;
  const pending = validation.finish(document).then(result => { settled = true; return result; });
  update();
  await vi.advanceTimersByTimeAsync(200);
  update([dependent]);
  await vi.advanceTimersByTimeAsync(249);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await pending).content).toContain('settled after an edited-file update');
});

it('excludes sibling folders and does not let unrelated updates imply edited-file validation', async () => {
  const validation = beginEditValidation(folder, edited);
  env.diagnostics = [[uri('/project-other/error.ts'), [diagnostic('Sibling error')]]];
  const pending = validation.finish(document);
  update([dependent]);
  await vi.advanceTimersByTimeAsync(2000);
  const result = await pending;
  expect(result.content).toContain('no edited-file diagnostic update');
  expect(result.content).not.toContain('Sibling error');
  expect(result.content).toContain('new: 0 errors');
});

it('resets the quiet window and enforces the absolute deadline', async () => {
  const validation = beginEditValidation(folder, edited);
  const pending = validation.finish(document);
  for (let index = 0; index < 10; index++) {
    update();
    await vi.advanceTimersByTimeAsync(200);
  }
  expect((await pending).content).toContain('did not settle within 2 seconds');
});

it.each(['before finish', 'during validation'])('cancels promptly %s', async timing => {
  const controller = new AbortController();
  const validation = beginEditValidation(folder, edited, controller.signal);
  if (timing === 'before finish') controller.abort();
  const pending = validation.finish(document);
  controller.abort();
  const result = await pending;
  expect(result.status).toBe('error');
  expect(result.content).toContain('cancelled');
  expect(result.content).toContain('saved and retained');
});

it('handles an already aborted signal and cancellation when diagnostics are unavailable', async () => {
  const controller = new AbortController();
  controller.abort();
  const first = beginEditValidation(folder, edited, controller.signal);
  expect((await first.finish(document)).status).toBe('error');
  env.getDiagnostics.mockImplementation(() => { throw new Error('unavailable'); });
  const later = new AbortController();
  const second = beginEditValidation(folder, edited, later.signal);
  later.abort();
  expect((await second.finish(document)).status).toBe('error');
});

it.each(['before finish', 'during validation'])('disposes cleanly %s', async timing => {
  const validation = beginEditValidation(folder, edited);
  if (timing === 'before finish') validation.dispose();
  const pending = validation.finish(document);
  validation.dispose();
  expect((await pending).content).toContain('disposed');
});

it('reports changes to the document during observation immediately', async () => {
  const validation = beginEditValidation(folder, edited);
  const pending = validation.finish(document);
  Object.assign(document, { version: 3, isDirty: true });
  for (const listener of env.documentListeners) listener({ document } as vscode.TextDocumentChangeEvent);
  expect((await pending).content).toContain('saved document changed');
});

it('reports a removed workspace without switching roots', async () => {
  const validation = beginEditValidation(folder, edited);
  const pending = validation.finish(document);
  env.folders = [];
  for (const listener of env.folderListeners) listener();
  expect((await pending).content).toContain('selected folder was removed');
});

it('allows saving when diagnostic access fails at the beginning', async () => {
  env.getDiagnostics.mockImplementation(() => { throw new Error('unavailable'); });
  const validation = beginEditValidation(folder, edited);
  const result = await validation.finish(document);
  expect(result.status).toBe('success');
  expect(result.content).toContain('inconclusive');
  expect(result.content).toContain('the pre-edit baseline and the post-edit snapshot could not be captured');
  expect(result.content).toContain('Diagnostic comparison counts unavailable');
  expect(result.content).not.toContain('new:');
});

it('does not misclassify existing errors as new when only the initial snapshot fails', async () => {
  env.diagnostics = [[edited, [diagnostic('Existing error')]]];
  env.getDiagnostics.mockImplementationOnce(() => { throw new Error('temporarily unavailable'); });
  const validation = beginEditValidation(folder, edited);
  const result = await validation.finish(document);
  expect(env.getDiagnostics).toHaveBeenCalledTimes(2);
  expect(result.status).toBe('success');
  expect(result.content).toContain('inconclusive');
  expect(result.content).toContain('the pre-edit baseline could not be captured');
  expect(result.content).toContain('Diagnostic comparison counts unavailable');
  expect(result.content).not.toContain('new:');
  expect(result.content).not.toContain('Repair the newly observed errors');
});

it('reports a diagnostic failure at the end without rejecting', async () => {
  env.diagnostics = [[edited, [diagnostic('Original error')]]];
  const validation = beginEditValidation(folder, edited);
  const pending = validation.finish(document);
  env.getDiagnostics.mockImplementation(() => { throw new Error('unavailable'); });
  update();
  await vi.advanceTimersByTimeAsync(250);
  const result = await pending;
  expect(result.status).toBe('success');
  expect(result.content).toContain('diagnostics are unavailable');
  expect(result.content).toContain('the post-edit snapshot could not be captured');
  expect(result.content).toContain('Diagnostic comparison counts unavailable');
  expect(result.content).not.toContain('remaining:');
  expect(result.content).not.toContain('Existing errors remain');
});

it('caps displayed entries while preserving full counts and putting errors first', async () => {
  const validation = beginEditValidation(folder, edited);
  env.diagnostics = [[edited, [
    ...Array.from({ length: 100 }, (_, index) => diagnostic(`Warning ${index}`, 1)),
    diagnostic('Priority error'),
  ]]];
  const pending = validation.finish(document);
  update();
  await vi.advanceTimersByTimeAsync(250);
  const result = await pending;
  expect(result.content).toContain('new: 1 errors, 100 warnings (101 diagnostics total)');
  expect(result.content).toContain('showing 80 of 101');
  expect(result.content.indexOf('Priority error')).toBeLessThan(result.content.indexOf('Warning 0'));
});

it('caps characters even for a single oversized diagnostic', async () => {
  const validation = beginEditValidation(folder, edited);
  env.diagnostics = [[edited, [diagnostic('x'.repeat(40000))]]];
  const pending = validation.finish(document);
  update();
  await vi.advanceTimersByTimeAsync(250);
  const result = await pending;
  expect(result.content.length).toBeLessThanOrEqual(30000);
  expect(result.content).toContain('showing 0 of 1');
  expect(result.status).toBe('error');
});
