import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { invokeAgentTool } from '../../src/agent-tools';

const env = vi.hoisted(() => ({
  folders: [] as vscode.WorkspaceFolder[], preferences: [] as string[], files: [] as vscode.Uri[],
  run: vi.fn(), getConfiguration: vi.fn(), afterRead: () => {},
}));
vi.mock('../../src/command-runner', () => ({ executeCommand: env.run, commandSucceeded: (result: { exitCode: number }) => result.exitCode === 0 }));
vi.mock('vscode', () => {
  const uri = (fsPath: string) => ({ fsPath, scheme: 'file', authority: '', toString: () => fsPath });
  return {
    Uri: { file: uri, joinPath: (root: { fsPath: string }, relative: string) => uri(path.resolve(root.fsPath, relative)) },
    RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
    workspace: {
      get workspaceFolders() { return env.folders; },
      findFiles: async () => env.files,
      fs: { readFile: async (target: { fsPath: string }) => { const bytes = await readFile(target.fsPath); env.afterRead(); return bytes; } },
      getConfiguration: env.getConfiguration,
    },
  };
});

let directory: string;
let folder: vscode.WorkspaceFolder;
const uri = (fsPath: string) => ({ fsPath, scheme: 'file', authority: '', toString: () => fsPath } as vscode.Uri);
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), 'verification-tools-'));
  folder = { name: 'project', index: 0, uri: uri(directory) };
  env.folders = [folder]; env.files = []; env.preferences = []; env.afterRead = () => {};
  env.getConfiguration.mockImplementation(() => ({ get: () => env.preferences }));
  env.run.mockResolvedValue({ command: 'npm', args: [], cwd: directory, exitCode: 0, stdout: '', stderr: '',
    signal: null, durationMs: 1, timedOut: false, cancelled: false, truncated: false, outputLimitExceeded: false, error: null });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function manifest(scripts: Record<string, string>, relative = '') {
  const target = path.join(directory, relative);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ scripts }));
  env.files.push(uri(path.join(target, 'package.json')));
}
const run = (command: string, args: string[], options: Parameters<typeof invokeAgentTool>[3] = {}) =>
  invokeAgentTool('verify', 'run_command', JSON.stringify({ command, args, verification: true }), { workspaceFolder: folder, approvalMode: 'safe', ...options });

it('uses folder-specific preferences and reports missing scripts without executing anything', async () => {
  await manifest({ lint: 'eslint .', build: 'tsc' }, 'apps/web');
  env.preferences = ['lint', 'test'];
  const result = await invokeAgentTool('discover', 'discover_verification_commands', '{}', { workspaceFolder: folder, approvalMode: 'safe' });
  expect(result.status).toBe('success');
  const report = JSON.parse(result.content);
  expect(report.commands.map((item: { category: string }) => item.category)).toEqual(['lint']);
  expect(report.missing).toEqual([{ project: 'apps/web/package.json', category: 'test' }]);
  expect(env.getConfiguration).toHaveBeenCalledWith('deeplocal', folder.uri);
  expect(env.run).not.toHaveBeenCalled();
});

it('skips malformed manifests and never invents scripts from them', async () => {
  await writeFile(path.join(directory, 'package.json'), '{broken');
  env.files = [uri(path.join(directory, 'package.json'))];
  const result = await invokeAgentTool('discover', 'discover_verification_commands', '{}', { workspaceFolder: folder, approvalMode: 'safe' });
  expect(JSON.parse(result.content).commands).toEqual([]);
  expect(JSON.parse(result.content).missing).toHaveLength(4);
  expect(env.run).not.toHaveBeenCalled();
});

it.each([
  ['npm', ['run', 'lint']], ['npm.cmd', ['run-script', 'lint']],
  ['pnpm', ['lint']], ['yarn', ['run', 'lint']],
])('requires approval for unsafe delegation through %s %j', async (command, args) => {
  await manifest({ lint: 'npm run ship', ship: 'git push' });
  const approve = vi.fn(async () => false);
  expect((await run(command, args, { approve })).status).toBe('declined');
  expect(approve).toHaveBeenCalledOnce(); expect(env.run).not.toHaveBeenCalled();
});

it.each([
  ['npm', ['--prefix', 'apps/web', 'run', 'lint']],
  ['pnpm', ['--dir=apps/web', 'run', 'lint']],
  ['yarn', ['--cwd', 'apps/web', 'lint']],
])('inspects lifecycle hooks in the selected package: %s %j', async (command, args) => {
  await manifest({ lint: 'eslint .' });
  await manifest({ lint: 'eslint .', postlint: 'npm publish' }, 'apps/web');
  const approve = vi.fn(async () => false);
  expect((await run(command, args, { approve })).status).toBe('declined');
  expect(approve).toHaveBeenCalledOnce(); expect(env.run).not.toHaveBeenCalled();
});

it.each(['every', 'safe', 'full', 'ask'] as const)('preserves %s mode for safe package checks', async approvalMode => {
  await manifest({ lint: 'eslint .' });
  const approve = vi.fn(async () => false);
  const result = await run('npm', ['run', 'lint'], { approvalMode, approve });
  expect(result.status).toBe(['every', 'ask'].includes(approvalMode) ? 'declined' : 'success');
  expect(approve).toHaveBeenCalledTimes(approvalMode === 'every' ? 1 : 0);
  expect(env.run).toHaveBeenCalledTimes(['safe', 'full'].includes(approvalMode) ? 1 : 0);
});

it('requires approval for opaque shell wrappers and unreadable package metadata', async () => {
  const approve = vi.fn(async () => false);
  expect((await run('cmd.exe', ['/d', '/c', 'npm run lint'], { approve })).status).toBe('declined');
  expect((await run('npm', ['run', 'lint'], { approve })).status).toBe('declined');
  expect(approve).toHaveBeenCalledTimes(2); expect(env.run).not.toHaveBeenCalled();
});

it('does not prompt or launch if cancellation occurs while inspecting metadata', async () => {
  await manifest({ lint: 'npm run deploy' });
  const controller = new AbortController();
  env.afterRead = () => controller.abort();
  const approve = vi.fn(async () => false);
  expect((await run('npm', ['run', 'lint'], { approve, signal: controller.signal })).status).toBe('error');
  expect(approve).not.toHaveBeenCalled(); expect(env.run).not.toHaveBeenCalled();
});
