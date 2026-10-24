import * as vscode from 'vscode';
import * as path from 'path';
import { ChatMessage, ChatTool } from './protocol';
import { parseToolInput } from './tool-input';
import { ApprovalMode } from './config';
import { isInWorkspace, requireWorkspaceFolder, workspaceRelativePath } from './agent-workspace';
import { findNewDuplicateImports, isTypeScriptPath } from './import-validation';
import { beginEditValidation, DiagnosticObservation, EditValidation } from './edit-validation';
import { executeCommand, commandSucceeded, CommandResult } from './command-runner';

// Upper bounds for caller-supplied limits; defaults sit below these.
const MAX_TEXT_CHARS = 60000;
const MAX_RESULT_COUNT = 500;

export interface AgentToolResult {
  callId: string;
  name: string;
  content: string;
  status: 'success' | 'error' | 'declined';
  command?: CommandResult;
  edit?: { path: string; saved: true; diagnostics?: DiagnosticObservation };
}

export interface AgentToolOptions {
  signal?: AbortSignal;
  workspaceFolder?: vscode.WorkspaceFolder;
  approve?: (message: string, preview?: () => Promise<void>) => Promise<boolean>;
  approvalMode?: ApprovalMode;
}

interface FileChangeOutcome {
  content: string;
  status: 'success' | 'error';
  saved: true;
  edit: NonNullable<AgentToolResult['edit']>;
}

type WorkspaceToolOutcome = string | FileChangeOutcome;

export function getAgentTools(): ChatTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: 'Move a single workspace file to the trash ONLY when the user explicitly asks to delete it. Supports a deletion diff. Never deletes directories.',
        parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_file',
        description: 'Create a NEW workspace file at the specified path. Never overwrites an existing file. Use this when asked to create a file.',
        parameters: { type: 'object', required: ['path', 'content'], properties: {
          path: { type: 'string' }, content: { type: 'string' },
        } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_workspace_summary',
        description: 'Summarize the current workspace: root path, folders, package scripts, and common project files.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_active_file',
        description: 'Get the path, language, and selected text summary for the active editor file.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_selection',
        description: 'Read the currently selected text in the active editor.',
        parameters: { type: 'object', properties: { maxChars: { type: 'number' } } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_diagnostics',
        description: 'Read VS Code diagnostics for the workspace or a specific file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            maxResults: { type: 'number' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'open_file',
        description: 'Open a workspace file in the editor.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_workspace_files',
        description: 'List files in the current VS Code workspace.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Optional glob pattern, for example **/*.ts.' },
            maxResults: { type: 'number', description: 'Maximum number of files to return.' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a UTF-8 text file from the current workspace.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            maxChars: { type: 'number' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_workspace',
        description: 'Search text in workspace files.',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            maxResults: { type: 'number' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or replace a workspace text file. Permission behavior follows the selected approval mode.',
        parameters: {
          type: 'object',
          required: ['path', 'content'],
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_in_file',
        description: 'Replace an exact text fragment in a workspace file. Permission behavior follows the selected approval mode.',
        parameters: {
          type: 'object',
          required: ['path', 'oldText', 'newText'],
          properties: {
            path: { type: 'string' },
            oldText: { type: 'string' },
            newText: { type: 'string' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a command in the workspace. Returns JSON with separate stdout/stderr, exitCode or signal, durationMs, error and timeout/cancellation/output-limit/truncation flags, including on failure. Permission behavior follows the selected approval mode.',
        parameters: {
          type: 'object',
          required: ['command', 'args'],
          properties: {
            command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  ];
}

export async function invokeAgentTool(callId: string, name: string, rawArguments: string, options: AgentToolOptions = {}): Promise<AgentToolResult> {
  let outcome: WorkspaceToolOutcome | undefined;
  try {
    if (name !== 'run_command') options.signal?.throwIfAborted();
    const args = parseToolInput(rawArguments);
    if (options.approvalMode === 'ask') {
      return result(callId, name, 'Ask-only mode does not permit agent operations. Explain the proposed action instead.', 'declined');
    }
    // Capture once, before any approval or other await.
    const folder = requireWorkspaceFolder(options.workspaceFolder);
    options = { ...options, workspaceFolder: folder };
    // Commands retain their cancellation/partial-output result rather than
    // losing it to the generic post-tool abort check. Validate launch below.
    if (name === 'run_command') return await runCommand(callId, args, options);
    if (options.approvalMode === 'every' && !isActionTool(name)) {
      const approved = await approveIfNeeded(name, args, `Allow tool: ${name}`, options);
      options.signal?.throwIfAborted();
      if (!approved) return result(callId, name, 'User declined tool execution. Do not retry without new instructions.', 'declined');
    }
    requireWorkspaceFolder(folder);
    outcome = await invokeWorkspaceTool(name, args, options, folder);
    options.signal?.throwIfAborted();
    requireWorkspaceFolder(folder);
    return typeof outcome === 'string'
      ? result(callId, name, outcome)
      : { ...result(callId, name, outcome.content, outcome.status), edit: outcome.edit };
  } catch (error) {
    if (outcome && typeof outcome !== 'string' && outcome.saved) {
      return { ...result(callId, name, `${outcome.content}\nTask interrupted after saving: ${messageOf(error)}. The saved change remains; read the file before making further edits.`, 'error'), edit: outcome.edit };
    }
    return result(callId, name, `Tool error: ${messageOf(error)}`, 'error');
  }
}

async function invokeWorkspaceTool(name: string, args: Record<string, unknown>, options: AgentToolOptions, folder: vscode.WorkspaceFolder): Promise<WorkspaceToolOutcome> {
  switch (name) {
    case 'get_workspace_summary':
      return await getWorkspaceSummary(folder);
    case 'get_active_file':
      return getActiveFile(folder);
    case 'get_selection':
      return getSelection(args, folder);
    case 'get_diagnostics':
      return getDiagnostics(args, folder);
    case 'open_file':
      return await openFile(args, folder);
    case 'list_workspace_files':
      return await listWorkspaceFiles(args, folder);
    case 'read_file':
      return await readFile(args, folder);
    case 'search_workspace':
      return await searchWorkspace(args, folder);
    case 'write_file':
      return await writeFile(args, options);
    case 'create_file':
      return await writeFile(args, options, true);
    case 'delete_file':
      return await deleteFile(args, options);
    case 'replace_in_file':
      return await replaceInFile(args, options);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function isActionTool(name: string): boolean {
  return ['write_file', 'create_file', 'replace_in_file', 'delete_file', 'run_command'].includes(name);
}

function needsApproval(name: string, args: Record<string, unknown>, mode: ApprovalMode | undefined): boolean {
  if (mode === 'full') return false;
  if (mode === 'every' || mode === undefined) return true;
  if (name === 'delete_file') return true;
  if (name === 'run_command') return unsafeCommand(String(args.command ?? ''), Array.isArray(args.args) ? args.args.map(String) : []);
  if (['write_file', 'create_file', 'replace_in_file'].includes(name)) return sensitivePath(String(args.path ?? ''));
  return false;
}

function sensitivePath(value: string): boolean {
  const path = value.toLowerCase();
  return /(^|\/)(\.env(?:\..*)?|.*credential.*|.*secret.*|.*token.*|.*key.*|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.git\/.*|settings\.json)$/.test(path);
}

function unsafeCommand(command: string, args: string[]): boolean {
  const value = `${command} ${args.join(' ')}`.toLowerCase();
  return /\b(rm|rmdir|del|format|shutdown|reboot|sudo|chmod|chown|curl|wget|ssh|scp|git)\b|\b(install|publish|push|commit|reset|clean|checkout|delete|remove|drop|truncate)\b/.test(value);
}

async function approveIfNeeded(name: string, args: Record<string, unknown>, message: string, options: AgentToolOptions, preview?: () => Promise<void>): Promise<boolean> {
  options.signal?.throwIfAborted();
  requireWorkspaceFolder(options.workspaceFolder);
  if (!needsApproval(name, args, options.approvalMode)) return true;
  return options.approve ? options.approve(message, preview) : confirm(message);
}

async function getWorkspaceSummary(folder: vscode.WorkspaceFolder): Promise<string> {
  const files = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '{package.json,tsconfig.json,pyproject.toml,requirements.txt,Cargo.toml,go.mod,README.md}'), '**/{node_modules,.git,dist,out}/**', 20)).filter(file => isInWorkspace(file, folder));
  const lines = [
    `Workspace: ${folder.name}`,
    `Root: ${folder.uri.fsPath}`,
    '',
    'Project files:',
    ...(files.length ? files.map((file) => `- ${workspaceRelativePath(file, folder)}`) : ['- none found']),
  ];

  const packageJson = files.find((file) => workspaceRelativePath(file, folder) === 'package.json');
  if (packageJson) {
    try {
      const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(packageJson));
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
      const scripts = Object.keys(parsed.scripts ?? {});
      lines.push('', 'npm scripts:', ...(scripts.length ? scripts.map((script) => `- ${script}`) : ['- none']));
    } catch {
      lines.push('', 'npm scripts: unable to parse package.json');
    }
  }

  return lines.join('\n');
}

function getActiveFile(folder: vscode.WorkspaceFolder): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return 'No active editor.';
  }
  if (!isInWorkspace(editor.document.uri, folder)) return 'The active editor is outside the selected workspace folder.';
  const relative = workspaceRelativePath(editor.document.uri, folder);
  const selection = editor.selection.isEmpty
    ? 'No selection.'
    : `Selection lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}.`;
  return [
    `Path: ${relative}`,
    `Language: ${editor.document.languageId}`,
    `Dirty: ${editor.document.isDirty}`,
    selection,
  ].join('\n');
}

function getSelection(args: Record<string, unknown>, folder: vscode.WorkspaceFolder): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return 'No active editor.';
  }
  if (!isInWorkspace(editor.document.uri, folder)) return 'The active editor is outside the selected workspace folder.';
  if (editor.selection.isEmpty) {
    return 'No selected text.';
  }
  return truncate(editor.document.getText(editor.selection), boundedNumber(args.maxChars, 20000, MAX_TEXT_CHARS));
}

function getDiagnostics(args: Record<string, unknown>, folder: vscode.WorkspaceFolder): string {
  const maxResults = boundedNumber(args.maxResults, 80, MAX_RESULT_COUNT);
  const target = typeof args.path === 'string' && args.path.trim()
    ? resolveWorkspacePath(args.path, folder)
    : undefined;
  const entries = target
    ? [[target, vscode.languages.getDiagnostics(target)] as const]
    : vscode.languages.getDiagnostics();
  const lines: string[] = [];

  for (const [uri, diagnostics] of entries) {
    if (!isInWorkspace(uri, folder)) continue;
    for (const diagnostic of diagnostics) {
      if (lines.length >= maxResults) {
        break;
      }
      const severity = vscode.DiagnosticSeverity[diagnostic.severity];
      lines.push(`${workspaceRelativePath(uri, folder)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${severity}: ${diagnostic.message}`);
    }
  }

  return lines.join('\n') || '(no diagnostics)';
}

async function openFile(args: Record<string, unknown>, folder: vscode.WorkspaceFolder): Promise<string> {
  const uri = resolveWorkspacePath(args.path, folder);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  return `Opened ${workspaceRelativePath(uri, folder)}.`;
}

export function toolResultsToMessages(toolCalls: AgentToolResult[]): ChatMessage[] {
  return toolCalls.map((tool) => ({
    role: 'tool',
    tool_call_id: tool.callId,
    content: tool.content,
  }));
}

function resolveWorkspacePath(input: unknown, folder: vscode.WorkspaceFolder): vscode.Uri {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('A workspace-relative path is required.');
  }

  if (path.isAbsolute(input) || path.win32.isAbsolute(input) || /^[a-z][a-z0-9+.-]*:/i.test(input)) {
    throw new Error('A workspace-relative path is required.');
  }
  const uri = vscode.Uri.joinPath(folder.uri, input);

  if (!isInWorkspace(uri, folder)) {
    throw new Error('Path escapes the workspace.');
  }

  return uri;
}

async function listWorkspaceFiles(args: Record<string, unknown>, folder: vscode.WorkspaceFolder): Promise<string> {
  const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern : '**/*';
  const maxResults = boundedNumber(args.maxResults, 200, MAX_RESULT_COUNT);
  const files = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), '**/{node_modules,.git,dist,out}/**', maxResults)).filter(file => isInWorkspace(file, folder));
  return files.map((file) => workspaceRelativePath(file, folder)).join('\n') || '(no files)';
}

async function readFile(args: Record<string, unknown>, folder: vscode.WorkspaceFolder): Promise<string> {
  const uri = resolveWorkspacePath(args.path, folder);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const unsupportedMessage = `Cannot read ${workspaceRelativePath(uri, folder)}: binary or unsupported file (expected UTF-8 text).`;
  if (bytes.includes(0)) {
    throw new Error(unsupportedMessage);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(unsupportedMessage);
  }
  return truncate(text, boundedNumber(args.maxChars, 30000, MAX_TEXT_CHARS));
}

async function searchWorkspace(args: Record<string, unknown>, folder: vscode.WorkspaceFolder): Promise<string> {
  const query = String(args.query ?? '').trim();
  if (!query) {
    throw new Error('query is required.');
  }

  const maxResults = boundedNumber(args.maxResults, 80, MAX_RESULT_COUNT);
  const files = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), '**/{node_modules,.git,dist,out}/**', 500)).filter(file => isInWorkspace(file, folder));
  const hits: string[] = [];

  for (const file of files) {
    if (hits.length >= maxResults) {
      break;
    }

    let text = '';
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length && hits.length < maxResults; index += 1) {
      if (lines[index].includes(query)) {
        hits.push(`${workspaceRelativePath(file, folder)}:${index + 1}: ${lines[index].trim()}`);
      }
    }
  }

  return hits.join('\n') || '(no matches)';
}

async function writeFile(args: Record<string, unknown>, options: AgentToolOptions, createOnly = false): Promise<WorkspaceToolOutcome> {
  const folder = requireWorkspaceFolder(options.workspaceFolder);
  const uri = resolveWorkspacePath(args.path, folder);
  if (typeof args.content !== 'string') throw new Error('content must be a string.');
  let exists = true;
  try { await vscode.workspace.fs.stat(uri); } catch (error) {
    if ((error as { code?: string }).code !== 'FileNotFound') throw error;
    exists = false;
  }
  if (createOnly && exists) throw new Error('File already exists; choose a new path or explicitly edit the existing file.');
  const document = exists ? await vscode.workspace.openTextDocument(uri) : undefined;
  return applyFileChange(uri, document, args.content, options);
}

async function replaceInFile(args: Record<string, unknown>, options: AgentToolOptions): Promise<WorkspaceToolOutcome> {
  const folder = requireWorkspaceFolder(options.workspaceFolder);
  const uri = resolveWorkspacePath(args.path, folder);
  const oldText = String(args.oldText ?? '');
  const newText = String(args.newText ?? '');

  if (!oldText) {
    throw new Error('oldText is required.');
  }

  const document = await vscode.workspace.openTextDocument(uri);
  const original = document.getText();
  if (!original.includes(oldText)) {
    throw new Error('oldText was not found; no changes applied.');
  }

  if (original.indexOf(oldText) !== original.lastIndexOf(oldText)) throw new Error('oldText matches multiple locations; provide more context.');
  return applyFileChange(uri, document, original.replace(oldText, newText), options);
}

async function deleteFile(args: Record<string, unknown>, options: AgentToolOptions): Promise<string> {
  const folder = requireWorkspaceFolder(options.workspaceFolder);
  const uri = resolveWorkspacePath(args.path, folder);
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type & vscode.FileType.Directory) throw new Error('delete_file only supports individual files, not directories.');
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.isDirty) throw new Error('File has unsaved changes. Save or discard them before requesting deletion.');
  const version = document.version;
  const label = workspaceRelativePath(uri, folder);
  const scheme = `deeplocal-delete-${Math.random().toString(36).slice(2)}`;
  const before = vscode.Uri.parse(`${scheme}:/before/${encodeURIComponent(label)}`);
  const after = vscode.Uri.parse(`${scheme}:/after/${encodeURIComponent(label)}`);
  const original = document.getText();
  const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent: target => target.toString() === before.toString() ? original : '',
  });
  try {
    const message = `Delete ${label} (move to trash)`;
    const preview = async () => { await vscode.commands.executeCommand('vscode.diff', before, after, `Delete ${label}`, { preview: true }); };
    const approved = await approveIfNeeded('delete_file', args, message, options, preview);
    options.signal?.throwIfAborted();
    requireWorkspaceFolder(options.workspaceFolder);
    if (!approved) return 'User declined file deletion. Do not retry without new instructions.';
    if (document.version !== version || document.isDirty) throw new Error('File changed during review; request deletion again after reviewing it.');
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
    return `Moved ${label} to the trash.`;
  } finally {
    provider.dispose();
  }
}

async function applyFileChange(uri: vscode.Uri, document: vscode.TextDocument | undefined, content: string, options: AgentToolOptions): Promise<WorkspaceToolOutcome> {
  const folder = requireWorkspaceFolder(options.workspaceFolder);
  const label = workspaceRelativePath(uri, folder);
  if (document?.isDirty) throw new Error('File has unsaved changes. Save or discard them before requesting an agent edit.');
  const version = document?.version;
  const original = document?.getText() ?? '';
  const typeScript = isTypeScriptPath(label);
  if (typeScript) {
    const conflicts = findNewDuplicateImports(label, original, content);
    if (conflicts.length) {
      const details = conflicts.slice(0, 80).map(conflict => `${conflict.name}: ${conflict.locations.map(location => `${label}:${location.line}:${location.character}`).join(', ')}`);
      throw new Error(`No change applied: new or worsened duplicate import bindings.\n${truncate(details.join('\n'), 30000)}${conflicts.length > 80 ? '\n... additional conflicts omitted ...' : ''}\nRead the existing imports and symbol usages, then modify the existing declaration instead of adding a conflicting import.`);
    }
  }
  const scheme = `deeplocal-preview-${Math.random().toString(36).slice(2)}`;
  const before = vscode.Uri.parse(`${scheme}:/before/${encodeURIComponent(label)}`);
  const after = vscode.Uri.parse(`${scheme}:/after/${encodeURIComponent(label)}`);
  const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent: (target) => target.toString() === before.toString() ? original : content,
  });
  let validation: EditValidation | undefined;
  let savedMessage: string | undefined;
  let report: Awaited<ReturnType<EditValidation['finish']>> | undefined;
  try {
    const preview = async () => { await vscode.commands.executeCommand('vscode.diff', before, after, `${document ? 'Edit' : 'Create'} ${label}`, { preview: true }); };
    const message = `${document ? 'Edit' : 'Create'} ${label} (${content.split('\n').length} lines)`;
    const approved = await approveIfNeeded(document ? 'write_file' : 'create_file', { path: label }, message, options, preview);
    options.signal?.throwIfAborted();
    requireWorkspaceFolder(options.workspaceFolder);
    if (!approved) return 'User declined file change. Do not retry this action without new instructions.';
    if (document && (document.version !== version || document.isDirty)) throw new Error('File changed during review; read it again before editing.');
    const edit = new vscode.WorkspaceEdit();
    if (document) edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(original.length)), content);
    else {
      edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
      edit.insert(uri, new vscode.Position(0, 0), content);
    }
    options.signal?.throwIfAborted();
    requireWorkspaceFolder(options.workspaceFolder);
    if (typeScript) validation = beginEditValidation(folder, uri, options.signal);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the file change.');
    const saved = await vscode.workspace.openTextDocument(uri);
    if (!await saved.save()) throw new Error('File change applied but could not be saved.');
    savedMessage = `${document ? 'Updated' : 'Created'} ${label}.`;
    report = await validation?.finish(saved);
    if (!options.signal?.aborted) await vscode.window.showTextDocument(saved, { preview: false, preserveFocus: true });
    return { content: `${savedMessage}${report ? `\n${report.content}` : ''}`, status: report?.status ?? 'success', saved: true,
      edit: { path: label, saved: true, diagnostics: report?.diagnostics } };
  } catch (error) {
    if (savedMessage) {
      return { content: `${savedMessage}\n${report?.content ?? 'Edit saved and retained.'}\n${report ? 'Editor display' : 'Verification or editor display'} did not finish: ${messageOf(error)}. Read the file and run relevant checks before claiming success.`, status: 'error', saved: true,
        edit: { path: label, saved: true, diagnostics: report?.diagnostics } };
    }
    throw error;
  } finally {
    validation?.dispose();
    provider.dispose();
  }
}

async function runCommand(callId: string, args: Record<string, unknown>, options: AgentToolOptions): Promise<AgentToolResult> {
  const command = String(args.command ?? '').trim();
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  if (!command) {
    throw new Error('command is required.');
  }

  const folder = requireWorkspaceFolder(options.workspaceFolder);
  if (folder.uri.scheme !== 'file') throw new Error('Commands require a local workspace folder.');
  if (options.signal?.aborted) {
    const stopped = await executeCommand(command, commandArgs, folder.uri.fsPath, options.signal);
    return { ...result(callId, 'run_command', JSON.stringify(stopped), 'error'), command: stopped };
  }
  const message = `Run command: ${command} ${commandArgs.join(' ')}?`;
  const ok = await approveIfNeeded('run_command', args, message, options);
  options.signal?.throwIfAborted();
  if (!ok) {
    return result(callId, 'run_command', 'User declined command execution.');
  }

  requireWorkspaceFolder(folder);
  const commandResult = await executeCommand(command, commandArgs, folder.uri.fsPath, options.signal);
  return { ...result(callId, 'run_command', JSON.stringify(commandResult, null, 2), commandSucceeded(commandResult) ? 'success' : 'error'), command: commandResult };
}

function result(callId: string, name: string, content: string, status: AgentToolResult['status'] = 'success'): AgentToolResult {
  return { callId, name, content, status: content.startsWith('User declined ') ? 'declined' : status };
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Caller-supplied limits may be smaller than the cap but never larger. */
function boundedNumber(value: unknown, fallback: number, max: number): number {
  return Math.min(positiveNumber(value, fallback), max);
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n... truncated ...` : text;
}

async function confirm(message: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Apply');
  return choice === 'Apply';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
