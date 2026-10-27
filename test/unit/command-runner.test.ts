import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCommand, commandSucceeded } from '../../src/command-runner';
import { boundedCommandText, redactCommandOutput } from '../../src/command-output';

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'command-result-')); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const run = (code: string, signal?: AbortSignal, limits?: Parameters<typeof executeCommand>[4]) =>
  executeCommand(process.execPath, ['-e', code], cwd, signal, limits);
async function waitForFile(file: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await access(file); return; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error('Child fixture did not become ready');
}

it.each([0, 1, 7])('retains separate streams and the actual exit code %i', async exitCode => {
  const result = await run(`process.stdout.write('src/main.ts:8 lint error\\n'); process.stderr.write('diagnostic detail\\n'); process.exitCode=${exitCode}`);
  expect(result).toMatchObject({ command: process.execPath, cwd, exitCode, signal: null,
    stdout: 'src/main.ts:8 lint error\n', stderr: 'diagnostic detail\n', timedOut: false, cancelled: false, outputLimitExceeded: false, truncated: false, error: null });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(commandSucceeded(result)).toBe(exitCode === 0);
});

it('represents a successful no-output process without inventing diagnostics', async () => {
  expect(await run('')).toMatchObject({ exitCode: 0, stdout: '', stderr: '', truncated: false });
});

it('launches the installed npm CLI without an implicit shell and preserves its evidence identity', async () => {
  const result = await executeCommand('npm', ['--version'], cwd);
  expect(result).toMatchObject({ command: 'npm', args: ['--version'], cwd, exitCode: 0, error: null });
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
});

it('distinguishes a missing executable and invalid cwd from a nonzero process exit', async () => {
  for (const result of [await executeCommand('missing-synthetic-command-78', [], cwd), await executeCommand(process.execPath, [], join(cwd, 'missing'))]) {
    expect(result).toMatchObject({ exitCode: null, signal: null, stdout: '', stderr: '', error: { code: 'ENOENT' } });
    expect(result.error?.message).toContain('executable and working directory');
    expect(commandSucceeded(result)).toBe(false);
  }
});

it.skipIf(process.platform === 'win32')('records process termination separately from exit code', async () => {
  expect(await run("process.kill(process.pid, 'SIGTERM')")).toMatchObject({ exitCode: null, signal: 'SIGTERM', timedOut: false, cancelled: false });
});

it('preserves partial diagnostics when the deadline expires', async () => {
  const result = await run("require('fs').writeSync(1, 'lint started\\n'); require('fs').writeSync(2, 'partial error\\n'); setInterval(()=>{},1000)", undefined, { timeoutMs: 1000 });
  expect(result).toMatchObject({ stdout: 'lint started\n', stderr: 'partial error\n', timedOut: true, cancelled: false, error: null });
  expect(commandSucceeded(result)).toBe(false);
  expect(result.durationMs).toBeLessThan(4000);
});

it('cancels a real child after output and reaps it without losing that output', async () => {
  const controller = new AbortController();
  const pending = run("require('fs').writeSync(1, 'partial stdout\\n'); require('fs').writeSync(2, 'partial stderr\\n'); require('fs').writeFileSync('ready',String(process.pid)); setInterval(()=>{},1000)", controller.signal);
  try { await waitForFile(join(cwd, 'ready')); } finally { controller.abort(); }
  const result = await pending;
  expect(result).toMatchObject({ stdout: 'partial stdout\n', stderr: 'partial stderr\n', cancelled: true, timedOut: false });
  const pid = Number(await readFile(join(cwd, 'ready'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
});

it('does not launch a process for a pre-aborted signal', async () => {
  const controller = new AbortController(); controller.abort();
  expect(await run("require('fs').writeFileSync('unexpected','started')", controller.signal)).toMatchObject({ cancelled: true, exitCode: null, signal: null, stdout: '', stderr: '' });
  await expect(access(join(cwd, 'unexpected'))).rejects.toThrow();
});

it.skipIf(process.platform === 'win32')('bounds shutdown for children that ignore SIGTERM', async () => {
  const result = await run("process.on('SIGTERM',()=>{});require('fs').writeSync(1,'started\\n');setInterval(()=>{},1000)", undefined, { timeoutMs: 500 });
  expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL', stdout: 'started\n', exitCode: null });
  expect(result.durationMs).toBeLessThan(4000);
});

it('keeps both diagnostic tails when the displayed output is shortened', async () => {
  const result = await run("process.stdout.write('stdout start\\n'+'x'.repeat(40000)+'\\nstdout final failure'); process.stderr.write('stderr start\\n'+'y'.repeat(40000)+'\\nstderr final failure')");
  expect(result.truncated).toBe(true);
  expect(result.outputLimitExceeded).toBe(false);
  expect(result.stdout).toContain('stdout start'); expect(result.stdout).toContain('stdout final failure');
  expect(result.stderr).toContain('stderr start'); expect(result.stderr).toContain('stderr final failure');
  expect(JSON.stringify(result).length).toBeLessThan(30000);
});

it('caps runaway capture explicitly while preserving the other stream', async () => {
  const result = await run("require('fs').writeSync(2,'important stderr\\n'); process.stdout.write('line\\n'.repeat(10000)); setInterval(()=>{},1000)", undefined, { maxBuffer: 4096 });
  expect(result).toMatchObject({ outputLimitExceeded: true, truncated: true, stderr: 'important stderr\n' });
  expect(result.stdout).toContain('output limit');
  expect(JSON.stringify(result).length).toBeLessThan(30000);
});

it('retains the production one-MiB capture ceiling and reports output-limit termination', async () => {
  const result = await run("require('fs').writeSync(2,'stderr diagnostic\\n');process.stdout.write('initial line\\n'+'x'.repeat(2*1024*1024));setInterval(()=>{},1000)");
  expect(result).toMatchObject({ outputLimitExceeded: true, truncated: true, stderr: 'stderr diagnostic\n' });
  expect(result.stdout).toContain('initial line');
  expect(result.stdout).toContain('incomplete line omitted');
  expect(JSON.stringify(result).length).toBeLessThan(30000);
});

it('redacts split credential markers before shortening, retaining harmless error locations', async () => {
  const sentinel = 'syntheticCredential78';
  // Read the value from a temporary fixture so it is not part of argv metadata.
  await writeFile(join(cwd, 'synthetic.txt'), sentinel);
  const result = await run("const fs=require('fs'); const value=fs.readFileSync('synthetic.txt','utf8'); process.stdout.write('OPENAI_API_'); setTimeout(()=>{process.stdout.write('KEY='+value+'\\n'+'x'.repeat(20000)+'\\nAuthorization: Bearer '+value+'\\nsrc/main.ts:8 lint failure');process.stderr.write('https://user:'+value+'@example.invalid/?access_token='+value)},20)");
  expect(JSON.stringify(result)).not.toContain(sentinel);
  expect(result.stdout).toContain('src/main.ts:8 lint failure');
  expect(result.stderr).toContain('[redacted]');
});

it('redacts metadata across argv boundaries and bounds the serialized payload', async () => {
  const result = await executeCommand(process.execPath, ['-e', '', '--', '--token', 'syntheticCredential78'], cwd);
  expect(result.args).toEqual(['[sensitive arguments redacted]']);
  expect(JSON.stringify(result)).not.toContain('syntheticCredential78');
  const large = await run("process.stdout.write(String.fromCharCode(1).repeat(50000)+'\\nfinal');process.stderr.write('\\\\'.repeat(40000)+'tail')");
  expect(JSON.stringify(large).length).toBeLessThan(30000);
  expect(large.stderr).toContain('tail');
});

it.each([
  'API_KEY=syntheticCredential78', '"api_key": "syntheticCredential78"',
  "password='syntheticCredential78 with spaces'", '--token syntheticCredential78',
  'Authorization: Basic syntheticCredential78', 'Proxy-Authorization: syntheticCredential78',
  'Cookie: sessionid=syntheticCredential78; other=syntheticCredential78',
  'Set-Cookie: sid=syntheticCredential78; HttpOnly',
  'Bearer syntheticCredential78', 'https://user:syntheticCredential78@example.invalid',
  'https://example.invalid/?access_token=syntheticCredential78&next=1',
  'curl -u user:syntheticCredential78',
  '-----BEGIN PRIVATE KEY-----\nsyntheticCredential78\n-----END PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----\nsyntheticCredential78',
  '\x1b[31mTOKEN\x1b[0m=syntheticCredential78',
])('sanitizes common credential syntax %s', text => {
  expect(redactCommandOutput(text)).not.toContain('syntheticCredential78');
  expect(redactCommandOutput(text)).toContain('redacted');
});

it('keeps ordinary diagnostic text and bounds JSON escapes without breaking surrogate pairs', () => {
  const ordinary = 'src/main.ts:8:1 error no-unused-vars\nExpected 2 but received 1\n日本語';
  expect(redactCommandOutput(ordinary)).toBe(ordinary);
  const bounded = boundedCommandText('👩'.repeat(3000) + '\\'.repeat(4000), 1000);
  expect(JSON.stringify(bounded.text).length).toBeLessThanOrEqual(1000);
  expect(bounded.truncated).toBe(true);
});

it('redacts complete quoted values, including escaped quotes and whitespace, without swallowing the next error', () => {
  for (const text of [String.raw`password="synthetic\"Credential78 with spaces"`, String.raw`token='synthetic\'Credential78 with spaces'`, 'api_key="syntheticCredential78']) {
    const output = redactCommandOutput(text + '\nsrc/main.ts:8 lint error');
    expect(output).not.toContain('Credential78');
    if (text.endsWith('spaces"') || text.endsWith("spaces'")) expect(output).toContain('src/main.ts:8 lint error');
  }
});
