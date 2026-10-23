import * as vscode from 'vscode';
import { isInWorkspace, requireWorkspaceFolder, workspaceRelativePath } from './agent-workspace';

type Outcome = { content: string; status: 'success' | 'error' };
type Observation = { key: string; path: string; line: number; character: number; severity: number; message: string; source: string; code: string };
type Snapshot = Map<string, Observation[]>;

export interface EditValidation {
  finish(document: vscode.TextDocument): Promise<Outcome>;
  dispose(): void;
}

const quietMs = 250;
const deadlineMs = 2000;
const maxEntries = 80;
const maxCharacters = 30000;

function snapshot(folder: vscode.WorkspaceFolder): Snapshot {
  const result: Snapshot = new Map();
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (!isInWorkspace(uri, folder)) continue;
    for (const diagnostic of diagnostics) {
      const code = String(typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code ?? '');
      const source = diagnostic.source ?? '';
      const key = JSON.stringify([uri.toString(), source, code, diagnostic.severity, diagnostic.message]);
      const entry: Observation = {
        key, path: workspaceRelativePath(uri, folder), line: diagnostic.range.start.line + 1,
        character: diagnostic.range.start.character + 1, severity: diagnostic.severity,
        message: diagnostic.message, source, code,
      };
      const entries = result.get(key) ?? [];
      entries.push(entry);
      result.set(key, entries);
    }
  }
  return result;
}

function describe(before: Snapshot | undefined, after: Snapshot | undefined, reason?: string, cancelled = false): Outcome {
  if (!before || !after) {
    const unavailable = [!before ? 'the pre-edit baseline' : '', !after ? 'the post-edit snapshot' : ''].filter(Boolean).join(' and ');
    return {
      content: [
        'The edit was saved and retained.',
        `Diagnostic validation is inconclusive: ${reason ?? 'diagnostic snapshots are unavailable.'}`,
        `Diagnostic comparison counts unavailable: ${unavailable} could not be captured. New, resolved, and remaining diagnostics cannot be determined.`,
        'VS Code diagnostic events do not identify the document version; this is best-effort observation, not proof of successful compilation.',
      ].join('\n'),
      status: cancelled ? 'error' : 'success',
    };
  }
  const groups: Record<'new' | 'resolved' | 'remaining', Observation[]> = { new: [], resolved: [], remaining: [] };
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(key) ?? [];
    const current = after.get(key) ?? [];
    const shared = Math.min(previous.length, current.length);
    groups.remaining.push(...current.slice(0, shared));
    groups.new.push(...current.slice(shared));
    groups.resolved.push(...previous.slice(shared));
  }
  const count = (entries: Observation[], severity: number) => entries.filter(entry => entry.severity === severity).length;
  const lines = [
    'The edit was saved and retained.',
    reason ? `Diagnostic validation is inconclusive: ${reason}` : 'Observed diagnostic changes settled after an edited-file update.',
    'VS Code diagnostic events do not identify the document version; this is best-effort observation, not proof of successful compilation.',
    ...(['new', 'resolved', 'remaining'] as const).map(kind => `${kind}: ${count(groups[kind], vscode.DiagnosticSeverity.Error)} errors, ${count(groups[kind], vscode.DiagnosticSeverity.Warning)} warnings (${groups[kind].length} diagnostics total).`),
  ];
  if (count(groups.new, vscode.DiagnosticSeverity.Error)) lines.push('Repair the newly observed errors before declaring the task complete.');
  if (count(groups.remaining, vscode.DiagnosticSeverity.Error)) lines.push('Existing errors remain; the task is not fully verified.');
  const details = (['new', 'remaining', 'resolved'] as const).flatMap(kind => groups[kind].map(entry => ({ kind, entry })));
  details.sort((a, b) => {
    const priority = (item: typeof a) => item.entry.severity === vscode.DiagnosticSeverity.Error ? (item.kind === 'new' ? 0 : 1) : 2;
    return priority(a) - priority(b);
  });
  let displayed = 0;
  for (const { kind, entry } of details) {
    const severity = ['error', 'warning', 'information', 'hint'][entry.severity] ?? String(entry.severity);
    const detail = `${kind} ${severity}: ${entry.path}:${entry.line}:${entry.character} ${entry.source}${entry.code ? `(${entry.code})` : ''}: ${entry.message}`;
    // Reserve space for the truncation notice and retain complete summary counts.
    if (displayed >= maxEntries || lines.join('\n').length + detail.length + 150 > maxCharacters) break;
    lines.push(detail);
    displayed++;
  }
  if (displayed < details.length) lines.push(`Diagnostic details truncated: showing ${displayed} of ${details.length} entries (limits: ${maxEntries} entries / ${maxCharacters} characters). Counts above are complete.`);
  return { content: lines.join('\n'), status: cancelled || count(groups.new, vscode.DiagnosticSeverity.Error) > 0 ? 'error' : 'success' };
}

/** Observe before applying an edit; finish only after the document has been saved. */
export function beginEditValidation(folder: vscode.WorkspaceFolder, uri: vscode.Uri, signal?: AbortSignal): EditValidation {
  let before: Snapshot | undefined;
  let failure: string | undefined;
  let editedFileUpdated = false;
  let disposed = false;
  let cancelled = signal?.aborted ?? false;
  let document: vscode.TextDocument | undefined;
  let version: number | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let resolve: ((result: Outcome) => void) | undefined;
  let completion: Promise<Outcome> | undefined;
  const subscriptions: vscode.Disposable[] = [];

  function cleanup(): void {
    clearTimeout(quietTimer);
    clearTimeout(deadlineTimer);
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
    signal?.removeEventListener('abort', abort);
    disposed = true;
  }

  function complete(reason?: string): Outcome {
    let after: Snapshot | undefined;
    try {
      requireWorkspaceFolder(folder);
      after = snapshot(folder);
    } catch {
      reason = 'workspace diagnostics are unavailable or the selected folder was removed.';
    }
    if (document && (document.version !== version || document.isDirty || document.isClosed)) {
      reason = 'the saved document changed or closed during validation.';
    }
    const result = describe(before, after, reason ?? failure, cancelled);
    cleanup();
    resolve?.(result);
    resolve = undefined;
    return result;
  }

  function scheduleQuiet(): void {
    clearTimeout(quietTimer);
    if (resolve && editedFileUpdated) quietTimer = setTimeout(() => complete(), quietMs);
  }

  function abort(): void {
    cancelled = true;
    failure = 'validation was cancelled; verification is incomplete.';
    if (resolve) complete(failure);
    else cleanup();
  }

  try {
    requireWorkspaceFolder(folder);
    // Register synchronously before reading the baseline so no edit-time event
    // can fall between baseline capture and subscription setup.
    subscriptions.push(vscode.languages.onDidChangeDiagnostics(event => {
      if (event.uris.some(changed => changed.toString() === uri.toString())) editedFileUpdated = true;
      if (event.uris.some(changed => isInWorkspace(changed, folder))) scheduleQuiet();
    }));
    subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      try { requireWorkspaceFolder(folder); } catch {
        failure = 'the selected workspace folder was removed.';
        if (resolve) complete(failure);
      }
    }));
    subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (document && event.document.uri.toString() === uri.toString() && (event.document.version !== version || event.document.isDirty)) {
        complete('the saved document changed during validation.');
      }
    }));
    signal?.addEventListener('abort', abort, { once: true });
    before = snapshot(folder);
    // Notifications raised during initialization cannot verify the later edit.
    editedFileUpdated = false;
    if (cancelled) abort();
  } catch {
    failure = 'workspace diagnostics or their change notifications are unavailable.';
    cleanup();
  }

  return {
    finish(savedDocument) {
      if (completion) return completion;
      document = savedDocument;
      version = savedDocument.version;
      if (signal?.aborted) {
        cancelled = true;
        failure = 'validation was cancelled; verification is incomplete.';
      }
      if (disposed || failure || cancelled) {
        completion = Promise.resolve(complete(failure ?? 'validation was disposed before it finished.'));
        return completion;
      }
      completion = new Promise<Outcome>(done => {
        resolve = done;
        deadlineTimer = setTimeout(() => complete(editedFileUpdated
          ? 'diagnostic updates did not settle within 2 seconds.'
          : 'no edited-file diagnostic update arrived within 2 seconds.'), deadlineMs);
        scheduleQuiet();
      });
      return completion;
    },
    dispose() {
      if (resolve) complete('validation was disposed before it finished.');
      else {
        failure ??= 'validation was disposed before it finished.';
        cleanup();
      }
    },
  };
}
