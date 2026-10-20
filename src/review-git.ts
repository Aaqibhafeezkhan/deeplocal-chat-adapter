import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import type { ReviewEvidenceSource, ReviewFile, ReviewRequest, ReviewSide } from './review-types';

const TEXT_LIMIT = 60_000;
const SEARCH_FILES = 500;
const SEARCH_RESULTS = 100;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
type Entry = { oid: string; mode: string };
type Tree = Map<string, Entry>;

function textContent(bytes: Buffer): string {
  let value: string;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Review evidence must be UTF-8 text.'); }
  if (value.includes('\0')) throw new Error('Binary files are unavailable as text review evidence.');
  if (value.length > TEXT_LIMIT) throw new Error(`Review source file exceeds the ${TEXT_LIMIT} character limit.`);
  return value;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** A pinned Git comparison. No command invoked here changes the repository. */
export class GitReviewSnapshot implements ReviewEvidenceSource {
  readonly files: ReviewFile[] = [];
  readonly limitations = ['Only tracked, saved files are included; untracked files and unsaved editor buffers are excluded.'];
  diff = '';
  label = '';
  private repo = '';
  private prefix = '';
  private base = '';
  private target = '';
  private head = '';
  private index = '';
  private initialPatch = '';
  private baseTree: Tree = new Map();
  private targetTree: Tree = new Map();
  private readonly cache = new Map<string, string>();
  private readonly workingReads = new Map<string, Buffer>();
  private readonly disabledFilters: Array<[string, string]> = [];

  constructor(private readonly root: string, readonly request: ReviewRequest, private readonly signal?: AbortSignal) {}

  private checkCancelled(): void {
    if (this.signal?.aborted) throw new Error('Code review cancelled.');
  }

  private async git(args: string[], limit = 8_000_000, allowNoConfigMatches = false): Promise<Buffer> {
    this.checkCancelled();
    const inheritedCount = Number(process.env.GIT_CONFIG_COUNT ?? '0');
    if (!Number.isSafeInteger(inheritedCount) || inheritedCount < 0) throw new Error('Invalid inherited Git configuration count.');
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_COUNT: String(inheritedCount + this.disabledFilters.length), GIT_NO_LAZY_FETCH: '1' };
    this.disabledFilters.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${inheritedCount + index}`] = key;
      env[`GIT_CONFIG_VALUE_${inheritedCount + index}`] = value;
    });
    // Git applies inherited GIT_CONFIG_PARAMETERS after counted environment
    // entries. Explicit command config must override those inherited filters.
    const filterArgs: string[] = [];
    if (process.env.GIT_CONFIG_PARAMETERS) {
      for (const [key, value] of this.disabledFilters) {
        if (key.includes('=')) throw new Error('Read-only review cannot safely override this inherited Git filter configuration.');
        filterArgs.push('-c', `${key}=${value}`);
      }
    }
    return new Promise((resolve, reject) => {
      execFile('git', ['--no-optional-locks', '--no-pager', '-c', 'core.quotepath=true', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false', ...filterArgs, ...args], {
        cwd: this.repo || this.root, encoding: 'buffer', maxBuffer: limit, timeout: 30_000,
        signal: this.signal, windowsHide: true, env,
      }, (error, stdout, stderr) => {
        if (error) {
          if (allowNoConfigMatches && 'code' in error && error.code === 1) resolve(stdout);
          else if (this.signal?.aborted) reject(new Error('Code review cancelled.'));
          else if ('code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new Error('Review evidence exceeds its size limit.'));
          else reject(new Error(`Git review failed: ${String(stderr).trim() || error.message}`));
        } else resolve(stdout);
      });
    });
  }

  private scope(): string[] { return this.prefix ? ['--', `:(top,literal)${this.prefix.slice(0, -1)}`] : ['--']; }

  private relative(repoPath: string): string | undefined {
    if (!repoPath.startsWith(this.prefix)) return undefined;
    const relative = repoPath.slice(this.prefix.length);
    return relative && inside(this.root, path.resolve(this.root, relative)) ? relative : undefined;
  }

  private async resolveCommit(ref: string): Promise<string> {
    if (!ref || ref.includes('\0')) throw new Error('A valid commit reference is required.');
    return (await this.git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).toString('utf8').trim();
  }

  private async currentHead(): Promise<string> {
    try { return await this.resolveCommit('HEAD'); }
    catch (error) {
      // A symbolic HEAD without its branch is a valid, unborn repository.
      await this.git(['symbolic-ref', '-q', 'HEAD']);
      const refs = (await this.git(['show-ref', '--head'] ).catch(() => Buffer.alloc(0))).toString('utf8');
      if (refs.split('\n').some(line => line.endsWith(' HEAD'))) throw error;
      this.checkCancelled();
      return '';
    }
  }

  private diffArgs(format: 'patch' | 'names'): string[] {
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--find-renames', '--ignore-submodules=none', '--submodule=short'];
    if (format === 'names') args.push('--name-status', '-z');
    else args.push('--patch', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/');
    if (this.request.source === 'staged') args.push('--cached', this.base);
    if (this.request.source === 'commits') args.push(this.base, this.target);
    return [...args, ...this.scope()];
  }

  private async patch(): Promise<string> {
    const result = (await this.git(this.diffArgs('patch'), TEXT_LIMIT * 4 + 4096)).toString('utf8');
    if (result.length > TEXT_LIMIT) throw new Error(`Review diff exceeds the ${TEXT_LIMIT} character limit. Narrow the comparison before reviewing.`);
    return result;
  }

  private parseTree(raw: Buffer, index: boolean): Tree {
    const tree: Tree = new Map();
    for (const record of raw.toString('utf8').split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      const header = record.slice(0, tab).split(' ');
      const relative = this.relative(record.slice(tab + 1));
      if (!relative) continue;
      if (index && header[2] !== '0') throw new Error('Resolve merge conflicts before reviewing this comparison.');
      tree.set(relative, { mode: header[0], oid: header[index ? 1 : 2] });
    }
    return tree;
  }

  private async tree(commit: string): Promise<Tree> {
    if (!commit || commit === EMPTY_TREE) return new Map();
    return this.parseTree(await this.git(['ls-tree', '-r', '-z', '--full-tree', commit, ...this.scope()]), false);
  }

  private workspacePatch(section: string, relative: string, oldPath?: string): string {
    if (!this.prefix) return section;
    const before = JSON.stringify(`a/${oldPath ?? relative}`);
    const after = JSON.stringify(`b/${relative}`);
    return section.split('\n').map(line => {
      if (line.startsWith('diff --git ')) return `diff --git ${before} ${after}`;
      if (line.startsWith('--- ') && line !== '--- /dev/null') return `--- ${before}`;
      if (line.startsWith('+++ ') && line !== '+++ /dev/null') return `+++ ${after}`;
      if (line.startsWith('rename from ')) return `rename from ${JSON.stringify(oldPath ?? relative)}`;
      if (line.startsWith('rename to ')) return `rename to ${JSON.stringify(relative)}`;
      if (line.startsWith('copy from ')) return `copy from ${JSON.stringify(oldPath ?? relative)}`;
      if (line.startsWith('copy to ')) return `copy to ${JSON.stringify(relative)}`;
      if (line.startsWith('Binary files ')) return `Binary files ${before} and ${after} differ`;
      return line;
    }).join('\n');
  }

  async initialize(): Promise<this> {
    // Config inspection does not refresh the index or convert worktree content.
    // Environment config entries preserve arbitrary filter subsection names
    // without interpreting them as options, shell text, or key=value arguments.
    const filterKeys = (await this.git(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'], 8_000_000, true)).toString('utf8').split('\0');
    const filters = new Set(filterKeys.filter(Boolean).map(key => key.replace(/\.(clean|process|required)$/i, '')));
    for (const filter of filters) {
      this.disabledFilters.push([`${filter}.clean`, ''], [`${filter}.process`, ''], [`${filter}.required`, 'false']);
    }
    if (filters.size) this.limitations.push('Configured Git clean/process filters were disabled; unstaged comparisons use saved content without those filter transformations.');
    const partialConfig = (await this.git(['config', '--null', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], 8_000_000, true)).toString('utf8');
    const partialSettings = new Map<string, string>();
    for (const setting of partialConfig.split('\0').filter(Boolean)) {
      const separator = setting.indexOf('\n');
      partialSettings.set(setting.slice(0, separator), setting.slice(separator + 1).trim());
    }
    const partial = [...partialSettings].some(([key, value]) => /^extensions\.partialclone$/i.test(key)
      ? Boolean(value) : !/^(false|no|off|[+-]?0+)$/i.test(value));
    if (partial) {
      throw new Error('Partial/promisor clones are not supported by read-only review; use a complete local clone.');
    }
    this.repo = (await this.git(['rev-parse', '--show-toplevel'])).toString('utf8').trim();
    this.prefix = path.relative(this.repo, this.root).split(path.sep).join('/');
    if (this.prefix) this.prefix += '/';
    if (!inside(this.repo, this.root)) throw new Error('The selected folder is outside the Git repository.');
    if (this.request.source === 'commits') {
      this.base = await this.resolveCommit(this.request.base ?? '');
      this.target = await this.resolveCommit(this.request.target ?? '');
      this.baseTree = await this.tree(this.base);
      this.targetTree = await this.tree(this.target);
      this.label = `${this.request.base} → ${this.request.target} (${this.base.slice(0, 8)} → ${this.target.slice(0, 8)})`;
    } else {
      this.head = await this.currentHead();
      this.base = this.head || EMPTY_TREE;
      this.index = (await this.git(['ls-files', '--stage', '-z', ...this.scope()])).toString('utf8');
      const indexTree = this.parseTree(Buffer.from(this.index), true);
      this.baseTree = this.request.source === 'staged' ? await this.tree(this.head) : indexTree;
      this.targetTree = indexTree;
      this.label = this.request.source === 'staged' ? 'Staged changes (HEAD → index)' : 'Unstaged changes (index → saved files)';
    }
    const nameSnapshot = (await this.git(this.diffArgs('names'))).toString('utf8');
    const names = nameSnapshot.split('\0');
    this.initialPatch = await this.patch();
    if ((await this.git(this.diffArgs('names'))).toString('utf8') !== nameSnapshot) throw new Error('Git review source changed. Start a new review.');
    const sections = this.initialPatch.split(/(?=^diff --git )/m).filter(Boolean);
    let sectionIndex = 0;
    const selectedSections: string[] = [];
    for (let i = 0; i < names.length && names[i];) {
      const status = names[i++];
      const first = names[i++];
      const renamed = status.startsWith('R') || status.startsWith('C');
      const last = renamed ? names[i++] : first;
      const section = sections[sectionIndex++] ?? '';
      const relative = this.relative(last);
      const oldPath = renamed ? this.relative(first) : undefined;
      if (!relative || (renamed && !oldPath)) {
        this.limitations.push('Changes crossing the selected workspace boundary are excluded.');
        continue;
      }
      const file: ReviewFile = { path: relative, ...(oldPath ? { oldPath } : {}), status, binary: /^Binary files |^GIT binary patch/m.test(section), hunks: [] };
      for (const match of section.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        file.hunks.push({ oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1) });
      }
      if (file.binary) this.limitations.push(`Binary content is not available for ${relative}.`);
      if (this.baseTree.get(oldPath ?? relative)?.mode === '160000' || this.targetTree.get(relative)?.mode === '160000') this.limitations.push(`Submodule contents are not available for ${relative}.`);
      this.files.push(file);
      selectedSections.push(this.workspacePatch(section, relative, oldPath));
    }
    this.diff = selectedSections.join('');
    await this.verifyUnchanged();
    return this;
  }

  private validatePath(value: string): string {
    if (!value || value.includes('\0') || value.includes('\\') || path.isAbsolute(value) || /^[a-z]:/i.test(value) || value.split('/').some(part => part === '..' || part === '.' || !part)) throw new Error('Review paths must stay within the selected workspace.');
    if (!inside(this.root, path.resolve(this.root, value))) throw new Error('Review path is outside the selected workspace.');
    return value;
  }

  private async workingFile(relative: string): Promise<Buffer> {
    const absolute = path.resolve(this.root, relative);
    const realRoot = await fs.realpath(this.root);
    const real = await fs.realpath(absolute);
    if (!inside(realRoot, real)) throw new Error('Review source follows a symlink outside the selected workspace.');
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error('Review source is not a regular file.');
    if (stat.size > TEXT_LIMIT * 4) throw new Error(`Review source file exceeds the ${TEXT_LIMIT} character limit.`);
    return fs.readFile(real);
  }

  async readFile(value: string, side: ReviewSide = 'target'): Promise<string> {
    return this.readContent(value, side, true);
  }

  private async readContent(value: string, side: ReviewSide, verify: boolean): Promise<string> {
    this.checkCancelled();
    const relative = this.validatePath(value);
    if (side !== 'base' && side !== 'target') throw new Error('Invalid review source side.');
    const key = `${side}:${relative}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const tree = side === 'base' ? this.baseTree : this.targetTree;
    const entry = tree.get(relative);
    if (!entry) throw new Error(`File is not present in the selected ${side} snapshot: ${relative}`);
    if (entry.mode === '160000') throw new Error('Submodule contents are unavailable as review evidence.');
    if (entry.mode === '120000') throw new Error('Symlink contents are unavailable as review evidence.');
    let bytes: Buffer;
    if (this.request.source === 'unstaged' && side === 'target') {
      if (verify) await this.verifyUnchanged();
      bytes = await this.workingFile(relative);
      this.workingReads.set(relative, bytes);
      if (verify) await this.verifyUnchanged();
    } else bytes = await this.git(['cat-file', 'blob', entry.oid], TEXT_LIMIT * 4 + 4096);
    const content = textContent(bytes);
    this.cache.set(key, content);
    return content;
  }

  async search(query: string): Promise<string> {
    if (!query || query.length > 200 || query.includes('\0')) throw new Error('Search requires 1–200 text characters.');
    await this.verifyUnchanged();
    const candidates = [...this.targetTree.keys()].sort();
    const lines: string[] = [];
    let skipped = 0;
    let truncated = candidates.length > SEARCH_FILES;
    for (const relative of candidates.slice(0, SEARCH_FILES)) {
      this.checkCancelled();
      let content: string;
      try { content = await this.readContent(relative, 'target', false); }
      catch (error) {
        this.checkCancelled();
        if (String(error).includes('changed')) throw error;
        skipped++;
        continue;
      }
      for (const [index, line] of content.split('\n').entries()) {
        if (!line.toLowerCase().includes(query.toLowerCase())) continue;
        if (line.length > 500) truncated = true;
        const result = `${relative}:${index + 1}: ${line.slice(0, 500)}`;
        if (lines.length >= SEARCH_RESULTS || lines.join('\n').length + result.length > 20_000) { truncated = true; break; }
        lines.push(result);
      }
      if (lines.length >= SEARCH_RESULTS) { truncated = true; break; }
    }
    await this.verifyUnchanged();
    if (skipped) {
      const limitation = `Search skipped ${skipped} files unavailable as bounded UTF-8 text evidence.`;
      if (!this.limitations.includes(limitation)) this.limitations.push(limitation);
    }
    if (truncated) {
      const limitation = `Search results were truncated by the ${SEARCH_FILES}-file, ${SEARCH_RESULTS}-match, 20,000-character output, or 500-character line limit.`;
      if (!this.limitations.includes(limitation)) this.limitations.push(limitation);
    }
    return `${lines.join('\n') || 'No matches.'}\nSearched at most ${SEARCH_FILES} tracked target files; ${skipped} unavailable text files skipped.${truncated ? ' Results truncated by the file, match, or output limit.' : ''}`;
  }

  async verifyUnchanged(): Promise<void> {
    this.checkCancelled();
    if (this.request.source === 'commits') return;
    const index = (await this.git(['ls-files', '--stage', '-z', ...this.scope()])).toString('utf8');
    if (index !== this.index || await this.currentHead() !== this.head || await this.patch() !== this.initialPatch) throw new Error('Git review source changed. Start a new review.');
    for (const [relative, previous] of this.workingReads) {
      let current: Buffer;
      try { current = await this.workingFile(relative); }
      catch { throw new Error('Git review source changed. Start a new review.'); }
      if (!current.equals(previous)) throw new Error('Git review source changed. Start a new review.');
    }
  }
}

export async function createGitReview(root: string, request: ReviewRequest, signal?: AbortSignal): Promise<GitReviewSnapshot> {
  if (!['unstaged', 'staged', 'commits'].includes(request.source)) throw new Error('Unknown Git review source.');
  return new GitReviewSnapshot(path.resolve(root), { ...request }, signal).initialize();
}
