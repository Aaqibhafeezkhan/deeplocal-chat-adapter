import { expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { invokeAgentTool } from '../../src/agent-tools';

const env = vi.hoisted(() => ({ text: '' }));

vi.mock('vscode', () => {
  const uri = (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => fsPath });
  const root = path.resolve('/project');
  return {
    Uri: { joinPath: (base: { fsPath: string }, relative: string) => uri(path.resolve(base.fsPath, relative)) },
    workspace: {
      workspaceFolders: [{ name: 'project', uri: uri(root) }],
      asRelativePath: (target: { fsPath: string }) => path.relative(root, target.fsPath),
      fs: { readFile: async () => new TextEncoder().encode(env.text) },
    },
  };
});

it('caps an oversized maxChars for read_file', async () => {
  env.text = 'a'.repeat(100000);

  const result = await invokeAgentTool('call-1', 'read_file', JSON.stringify({ path: 'big.txt', maxChars: 1e9 }));

  expect(result.status).toBe('success');
  expect(result.content.length).toBeLessThanOrEqual(60100);
  expect(result.content).toContain('... truncated ...');
});
