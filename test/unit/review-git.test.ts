import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGitReview } from '../../src/review-git';

let root: string;
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
}
async function write(name: string, value: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await fs.writeFile(path.join(root, name), value);
}
function commit(message: string): string {
  git('add', '--all');
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD').trim();
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'deeplocal-review-'));
  git('init', '-q');
  git('config', 'user.name', 'Review Test');
  git('config', 'user.email', 'review@example.invalid');
  git('config', 'core.autocrlf', 'false');
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

it('pins staged blobs while the saved working tree differs', async () => {
  await write('sample.txt', 'base\n');
  commit('base');
  await write('sample.txt', 'staged\n');
  git('add', 'sample.txt');
  await write('sample.txt', 'working\n');
  const review = await createGitReview(root, { source: 'staged' });
  expect(review.files.map(file => file.path)).toEqual(['sample.txt']);
  expect(await review.readFile('sample.txt', 'base')).toBe('base\n');
  expect(await review.readFile('sample.txt')).toBe('staged\n');
  expect(await review.search('staged')).toContain('sample.txt:1: staged');
  expect(review.diff).toContain('+staged');
  await review.verifyUnchanged();
});

it('compares unstaged changes with the index and maps separated hunks', async () => {
  const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  await write('sample.txt', original.join('\n') + '\n');
  commit('base');
  original[0] = 'staged first';
  await write('sample.txt', original.join('\n') + '\n');
  git('add', 'sample.txt');
  const working = [...original];
  working[1] = 'working second';
  working[26] = 'working twenty seven';
  await write('sample.txt', working.join('\n') + '\n');
  const review = await createGitReview(root, { source: 'unstaged' });
  expect(await review.readFile('sample.txt', 'base')).toContain('staged first');
  expect(await review.readFile('sample.txt')).toContain('working second');
  expect(review.files[0].hunks).toEqual([
    { oldStart: 1, oldLines: 5, newStart: 1, newLines: 5 },
    { oldStart: 24, oldLines: 7, newStart: 24, newLines: 7 },
  ]);
});

it('pins direct commit comparisons and context despite dirty files and moved refs', async () => {
  await write('sample.txt', 'one\n');
  await write('context.txt', 'original context\n');
  const base = commit('base');
  await write('sample.txt', 'two\n');
  const target = commit('target');
  git('branch', 'review-target', target);
  await write('sample.txt', 'dirty\n');
  await write('context.txt', 'contaminated context\n');
  git('add', 'context.txt');
  const review = await createGitReview(root, { source: 'commits', base, target: 'review-target' });
  git('branch', '-f', 'review-target', base);
  expect(await review.readFile('sample.txt')).toBe('two\n');
  expect(await review.readFile('context.txt')).toBe('original context\n');
  expect(await review.readFile('sample.txt', 'base')).toBe('one\n');
  expect(await review.search('original')).toContain('context.txt:1: original context');
  await review.verifyUnchanged();
});

it('supports staged additions before the first commit and empty diffs', async () => {
  await write('new.txt', 'initial\n');
  git('add', 'new.txt');
  const review = await createGitReview(root, { source: 'staged' });
  expect(review.files[0]).toMatchObject({ path: 'new.txt', status: 'A', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }] });
  expect(await review.readFile('new.txt')).toBe('initial\n');
  await expect(review.readFile('new.txt', 'base')).rejects.toThrow('not present');
  commit('first');
  expect((await createGitReview(root, { source: 'staged' })).files).toEqual([]);
  expect((await createGitReview(root, { source: 'unstaged' })).diff).toBe('');
});

it('handles Unicode and whitespace names, renames and deletes', async () => {
  await write('old ü name.txt', 'unchanged rename content\n');
  await write('remove.txt', 'gone\n');
  commit('base');
  git('mv', 'old ü name.txt', 'new ü name.txt');
  git('rm', '-q', 'remove.txt');
  const review = await createGitReview(root, { source: 'staged' });
  expect(review.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'new ü name.txt', oldPath: 'old ü name.txt', status: 'R100' }),
    expect.objectContaining({ path: 'remove.txt', status: 'D' }),
  ]));
  expect(await review.readFile('old ü name.txt', 'base')).toBe('unchanged rename content\n');
  await expect(review.readFile('remove.txt')).rejects.toThrow('not present');
});

it('confines selected subfolder diffs and context', async () => {
  await write('folder/inside.txt', 'inside\n');
  await write('outside.txt', 'outside\n');
  const base = commit('base');
  await write('folder/inside.txt', 'changed inside\n');
  await write('outside.txt', 'changed outside\n');
  const target = commit('target');
  const review = await createGitReview(path.join(root, 'folder'), { source: 'commits', base, target });
  expect(review.files.map(file => file.path)).toEqual(['inside.txt']);
  expect(review.diff).not.toContain('changed outside');
  expect(review.diff).not.toContain('folder/inside.txt');
  expect(await review.readFile('inside.txt')).toBe('changed inside\n');
  await expect(review.readFile('../outside.txt')).rejects.toThrow('within');
  await expect(review.readFile('/outside.txt')).rejects.toThrow('within');
  await expect(review.readFile('outside.txt')).rejects.toThrow('not present');
});

it('rejects invalid refs, option-shaped refs and invalid paths', async () => {
  await write('sample.txt', 'base\n');
  const base = commit('base');
  for (const target of ['--help', 'missing', 'HEAD\0extra']) {
    await expect(createGitReview(root, { source: 'commits', base, target })).rejects.toThrow();
  }
  const review = await createGitReview(root, { source: 'staged' });
  for (const name of ['../sample.txt', 'C:/sample.txt', '..\\sample.txt', 'sample.txt\0']) {
    await expect(review.readFile(name)).rejects.toThrow();
  }
});

it('reports binary limitations and refuses oversized evidence', async () => {
  await write('binary.dat', Buffer.from([1, 0, 2]));
  git('add', 'binary.dat');
  const review = await createGitReview(root, { source: 'staged' });
  expect(review.files[0].binary).toBe(true);
  expect(review.limitations.join(' ')).toContain('Binary');
  await expect(review.readFile('binary.dat')).rejects.toThrow('Binary');
  await write('large.txt', 'x'.repeat(60_001));
  git('add', 'large.txt');
  await expect(createGitReview(root, { source: 'staged' })).rejects.toThrow('limit');
});

it('detects index and saved file changes, including files already cached', async () => {
  await write('sample.txt', 'base\n');
  commit('base');
  await write('sample.txt', 'working\n');
  const review = await createGitReview(root, { source: 'unstaged' });
  await review.readFile('sample.txt');
  await write('sample.txt', 'changed again\n');
  await expect(review.verifyUnchanged()).rejects.toThrow('changed');
  const staged = await createGitReview(root, { source: 'staged' });
  git('add', 'sample.txt');
  await expect(staged.verifyUnchanged()).rejects.toThrow('changed');
});

it('rejects cancelled reviews before launching Git', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(createGitReview(root, { source: 'unstaged' }, abort.signal)).rejects.toThrow('cancelled');
});

it('bounds search matches and refuses oversized unchanged source context', async () => {
  await write('many.txt', 'needle\n'.repeat(110));
  await write('large-context.txt', 'x'.repeat(60_001));
  commit('base');
  const review = await createGitReview(root, { source: 'staged' });
  const results = await review.search('needle');
  expect(results).toContain('many.txt:100: needle');
  expect(results).not.toContain('many.txt:101: needle');
  expect(results).toContain('truncated');
  expect(review.limitations.join(' ')).toContain('Search results were truncated');
  expect(review.limitations.join(' ')).toContain('Search skipped 1');
  await expect(review.readFile('large-context.txt')).rejects.toThrow('limit');
});

it('rejects a working-tree path replaced by a symlink outside the selected root', async context => {
  await write('folder/inside.txt', 'inside\n');
  await write('outside.txt', 'outside\n');
  commit('base');
  const selected = path.join(root, 'folder');
  await fs.rm(path.join(selected, 'inside.txt'));
  try { await fs.symlink(path.join(root, 'outside.txt'), path.join(selected, 'inside.txt')); }
  catch (error) {
    // Windows installations without Developer Mode cannot create file symlinks.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
    throw error;
  }
  const review = await createGitReview(selected, { source: 'unstaged' });
  await expect(review.readFile('inside.txt')).rejects.toThrow('symlink outside');
});

it.each(['clean', 'process'])('never invokes configured %s filters or fsmonitor helpers', async filter => {
  await write('.gitattributes', '*.txt filter=audit\n');
  await write('sample.txt', 'base\n');
  commit('base');
  const marker = path.join(root, 'helper-ran');
  const script = path.join(root, 'configured-helper.cjs');
  await fs.writeFile(script, 'require("fs").writeFileSync(process.argv[2], "helper executed"); process.exit(0);');
  const command = `"${process.execPath}" "${script}" "${marker}"`;
  git('config', `filter.audit.${filter}`, command);
  git('config', 'filter.audit.required', 'true');
  git('config', 'core.fsmonitor', command);
  git('config', 'diff.autoRefreshIndex', 'true');
  await write('sample.txt', 'saved change\n');
  const indexPath = path.join(root, '.git', 'index');
  const index = await fs.readFile(indexPath);
  const review = await createGitReview(root, { source: 'unstaged' });
  expect(await review.readFile('sample.txt')).toBe('saved change\n');
  await review.verifyUnchanged();
  expect(review.limitations.join(' ')).toContain('filters were disabled');
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(indexPath)).toEqual(index);
  expect(await fs.readFile(path.join(root, 'sample.txt'), 'utf8')).toBe('saved change\n');
});

it('preserves inherited Git config while overriding its executable filters', async () => {
  await write('.gitattributes', '*.txt filter=inherited\n');
  await write('sample.txt', 'base\n');
  commit('base');
  await write('sample.txt', 'saved\n');
  git('config', 'remote.not-partial.promisor', 'false');
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'filter.inherited.clean');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'this-helper-must-never-execute');
  vi.stubEnv('GIT_CONFIG_PARAMETERS', "'filter.inherited.clean=this-helper-must-never-execute' 'filter.inherited.required=true'");
  const review = await createGitReview(root, { source: 'unstaged' });
  expect(review.limitations.join(' ')).toContain('filters were disabled');
  expect(await review.readFile('sample.txt')).toBe('saved\n');
  await review.verifyUnchanged();
});

it('does not fetch missing promisor objects or launch a remote helper', async () => {
  await write('sample.txt', 'base\n');
  const target = commit('base');
  const blob = git('rev-parse', 'HEAD:sample.txt').trim();
  await fs.rm(path.join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const marker = path.join(root, 'remote-ran');
  const script = path.join(root, 'remote-helper.cjs');
  await fs.writeFile(script, 'require("fs").writeFileSync(process.argv[2], "remote executed"); process.exit(0);');
  const extArgument = (value: string) => value.replace(/%/g, '%%').replace(/ /g, '% ');
  git('config', 'remote.audit.url', `ext::${[process.execPath, script, marker].map(extArgument).join(' ')}`);
  git('config', 'remote.audit.promisor', 'true');
  git('config', 'protocol.ext.allow', 'always');
  await expect(createGitReview(root, { source: 'commits', base: target, target })).rejects.toThrow('Partial/promisor clones are not supported');
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(path.join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)))).rejects.toMatchObject({ code: 'ENOENT' });
  // Positive control: ordinary Git really would invoke this fixture helper.
  expect(() => git('cat-file', 'blob', blob)).toThrow();
  expect(await fs.readFile(marker, 'utf8')).toBe('remote executed');
});
