import { describe, expect, it } from 'vitest';
import { discoverProjectVerification, isUnsafeVerificationScript } from '../../src/project-verification';

describe('discoverProjectVerification', () => {
  it('discovers distinct existing npm scripts for each verification category', () => {
    const report = discoverProjectVerification([{ path: 'package.json', scripts: { lint: 'eslint .', 'check-types': 'tsc --noEmit', build: 'vite build', test: 'vitest run' } }], { 'package.json': '{}', 'package-lock.json': '' });
    expect(report.commands.map(item => [item.category, item.command, item.args])).toEqual([
      ['lint', 'npm', ['run', 'lint']], ['typecheck', 'npm', ['run', 'check-types']],
      ['build', 'npm', ['run', 'build']], ['test', 'npm', ['run', 'test']],
    ]);
    expect(report.missing).toEqual([]);
  });

  it('uses the package manager for the relevant project and respects preferences', () => {
    const report = discoverProjectVerification([{ path: 'apps/web/package.json', scripts: { lint: 'eslint .', build: 'vite build', test: 'vitest run' } }], { 'apps/web/package.json': '{}', 'apps/web/pnpm-lock.yaml': '' }, ['build', 'test']);
    expect(report.commands.map(item => [item.category, item.command, item.args])).toEqual([['build', 'pnpm', ['--dir', 'apps/web', 'run', 'build']], ['test', 'pnpm', ['--dir', 'apps/web', 'run', 'test']]]);
    expect(report.missing).toEqual([]);
    expect(report.preferences).toEqual(['build', 'test']);
  });

  it('rejects unsafe scripts reached through delegation and lifecycle hooks', () => {
    expect(isUnsafeVerificationScript('lint', 'npm run deploy && eslint .', { lint: 'npm run deploy && eslint .', deploy: 'node deploy.js' })).toBe(true);
    expect(isUnsafeVerificationScript('lint', 'eslint .', { lint: 'eslint .', prelint: 'npm run deploy', deploy: 'node deploy.js' })).toBe(true);
    const report = discoverProjectVerification([{ path: 'package.json', scripts: { lint: 'npm run deploy && eslint .', build: 'vite build' } }], { 'package.json': '{}' }, ['lint', 'test']);
    expect(report.commands).toEqual([]);
    expect(report.skippedUnsafe).toMatchObject([{ script: 'lint' }]);
    expect(report.missing).toEqual([{ project: 'package.json', category: 'lint' }, { project: 'package.json', category: 'test' }]);
  });

  it('preserves independent Go and Rust checks in a mixed-toolchain directory', () => {
    const report = discoverProjectVerification([], { 'go.mod': 'module example', 'Cargo.toml': '[package]' }, ['lint', 'typecheck', 'build', 'test']);
    const commands = report.commands.map(item => item.command + ' ' + item.args.join(' '));
    expect(commands).toContain('go vet ./...');
    expect(commands).toContain('go build ./...');
    expect(commands).toContain('go test ./...');
    expect(commands).toContain('cargo fmt --manifest-path Cargo.toml -- --check');
    expect(commands).toContain('cargo check --manifest-path Cargo.toml');
    expect(commands).toContain('cargo test --manifest-path Cargo.toml');
  });

  it('discovers configured Python tools with runnable root arguments', () => {
    const report = discoverProjectVerification([], { 'pyproject.toml': '[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]' }, ['lint', 'typecheck', 'test']);
    expect(report.commands.map(item => item.command + ' ' + item.args.join(' '))).toEqual(['ruff check .', 'mypy .', 'python -m pytest']);
  });

  it('discovers nested manifests independently', () => {
    const report = discoverProjectVerification([
      { path: 'apps/web/package.json', scripts: { lint: 'eslint .', test: 'vitest run' } },
      { path: 'services/api/package.json', scripts: { build: 'tsc', test: 'vitest run' } },
    ], {
      'apps/web/package.json': '{}', 'apps/web/package-lock.json': '',
      'services/api/package.json': '{}', 'services/api/yarn.lock': '',
    }, ['lint', 'build', 'test']);
    expect(report.commands.map(item => [item.project, item.command, item.category])).toEqual([
      ['apps/web/package.json', 'npm', 'lint'], ['apps/web/package.json', 'npm', 'test'],
      ['services/api/package.json', 'yarn', 'build'], ['services/api/package.json', 'yarn', 'test'],
    ]);
  });
});
