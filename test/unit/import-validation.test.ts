import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { findNewDuplicateImports, isTypeScriptPath } from '../../src/import-validation';

const names = ['FoodRenderer', 'SnakeRenderer', 'SettingsManager', 'ScoreManager'];
const original = `import { ${names.join(', ')} } from './renderers';\n`;

function compile(source: string): readonly ts.Diagnostic[] {
  const files: Record<string, string> = {
    '/fixture/main.ts': source,
    '/fixture/renderers.ts': names.map(name => `export class ${name} {}`).join('\n')
  };
  const options: ts.CompilerOptions = { noLib: true, strict: true, module: ts.ModuleKind.CommonJS };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => files[file] === undefined
    ? undefined
    : ts.createSourceFile(file, files[file], ts.ScriptTarget.Latest, true);
  host.resolveModuleNames = moduleNames => moduleNames.map(name => name === './renderers'
    ? { resolvedFileName: '/fixture/renderers.ts', extension: ts.Extension.Ts }
    : undefined);
  return ts.createProgram(Object.keys(files), options, host).getSemanticDiagnostics();
}

describe('TypeScript import validation', () => {
  it.each(['file.ts', 'file.tsx', 'file.mts', 'file.cts', 'file.d.ts', 'file.d.mts', 'file.d.cts', 'FILE.TS'])(
    'recognizes %s', path => expect(isTypeScriptPath(path)).toBe(true)
  );

  it('does not apply to JavaScript or other file types', () => {
    for (const path of ['file.js', 'file.jsx', 'file.ts.map', 'file.json']) {
      expect(isTypeScriptPath(path)).toBe(false);
      expect(findNewDuplicateImports(path, '', 'import { A, A } from "x";')).toEqual([]);
    }
  });

  it('rejects the reported duplicate type imports with candidate locations', () => {
    const candidate = `${original}import type { ${names.join(', ')} } from './renderers';\n`;
    const duplicates = findNewDuplicateImports('main.ts', original, candidate);
    expect(duplicates.map(item => item.name)).toEqual(names);
    expect(duplicates[0].locations).toEqual([{ line: 1, character: 10 }, { line: 2, character: 15 }]);
    expect(duplicates.every(item => item.locations.length === 2)).toBe(true);
  });

  it.each([
    'import A from "a"; import type A from "b";',
    'import * as A from "a"; import { B as A } from "b";',
    'import { B as A, C as A } from "a";',
    'import { A, type A } from "a";',
    'import A = require("a"); import A = require("b");',
    'import type A = require("a"); import { A } from "b";'
  ])('detects duplicate local bindings: %s', candidate => {
    expect(findNewDuplicateImports('main.ts', '', candidate).map(item => item.name)).toEqual(['A']);
  });

  it('accepts distinct aliases, separate declarations, side effects, and runtime imports', () => {
    const candidate = [
      'import { A as First } from "a";',
      'import { A as Second } from "a";',
      'import type { B } from "a";',
      'import Default from "a";',
      'import * as Namespace from "a";',
      'import "a";',
      'new Default();'
    ].join('\n');
    expect(findNewDuplicateImports('main.ts', '', candidate)).toEqual([]);
  });

  it('allows existing duplication to remain unchanged or be repaired', () => {
    const existing = 'import { A, A, A } from "a";';
    expect(findNewDuplicateImports('main.ts', existing, `${existing}\nconst changed = 1;`)).toEqual([]);
    expect(findNewDuplicateImports('main.ts', existing, 'import { A, A } from "a";')).toEqual([]);
    expect(findNewDuplicateImports('main.ts', existing, 'import { A } from "a";')).toEqual([]);
    expect(findNewDuplicateImports('main.ts', existing, 'import { A, A, A, A } from "a";')[0].locations).toHaveLength(4);
  });

  it('keeps distinct ambient modules and nested scopes separate', () => {
    const candidate = [
      'import { A } from "a";',
      'declare module "one" { import { A } from "a"; }',
      'declare module "two" { import { A } from "a"; }',
      'declare namespace Outer { import A = Inner.A; namespace Nested { import A = Inner.A; } }'
    ].join('\n');
    expect(findNewDuplicateImports('main.d.ts', '', candidate)).toEqual([]);
  });

  it('keeps import-local scopes separate across merged ambient declarations like the compiler', () => {
    const first = 'declare module "one" { import { A } from "a"; }';
    expect(findNewDuplicateImports('main.d.ts', first, `${first}\n${first}`)).toEqual([]);
    expect(compile(`${first}\n${first}`).filter(item => item.code === 2300)).toEqual([]);
    const namespace = 'declare namespace Outer.Inner { import A = Other.A; }';
    expect(findNewDuplicateImports('main.d.ts', namespace, `${namespace}\n${namespace}`)).toEqual([]);
    expect(compile(`${namespace}\n${namespace}`).filter(item => item.code === 2300)).toEqual([]);
  });

  it('rejects a new duplicate inside one ambient module while preserving neighboring scopes', () => {
    const before = 'declare module "one" { import { A } from "a"; }';
    const after = 'declare module "one" { import { A, A } from "a"; }';
    expect(findNewDuplicateImports('main.d.ts', before, after).map(item => item.name)).toEqual(['A']);
    expect(compile(after).filter(item => item.code === 2300)).toHaveLength(2);
  });

  it('ignores strings, comments, dynamic imports, and synthesized missing names', () => {
    const candidate = [
      '// import { A, A } from "a";',
      'const text = "import { A, A } from \'a\';";',
      'const load = import("a");',
      'const value = { A: 1 };',
      'import { } from "a";',
      'import { B as } from "a";',
      'import { C as } from "a";'
    ].join('\n');
    expect(findNewDuplicateImports('main.ts', '', candidate)).toEqual([]);
  });

  it('demonstrates duplicate-identifier errors and preserves runtime constructors in the correction', () => {
    const faulty = `${original}import type { ${names.join(', ')} } from './renderers';`;
    expect(compile(faulty).filter(item => item.code === 2300)).toHaveLength(8);
    const corrected = [
      "import { FoodRenderer, SnakeRenderer } from './renderers';",
      "import type { SettingsManager, ScoreManager } from './renderers';",
      'export const food = new FoodRenderer();',
      'export const snake = new SnakeRenderer();',
      'export interface Managers { settings: SettingsManager; score: ScoreManager }'
    ].join('\n');
    expect(compile(corrected)).toEqual([]);
    expect(findNewDuplicateImports('main.ts', faulty, corrected)).toEqual([]);
    expect(compile(corrected.replace('import { FoodRenderer', 'import type { FoodRenderer'))
      .filter(item => item.code === 1361)).toHaveLength(2);
  });

  it('respects an explicit consistent-type-imports lint fixture without changing project rules', async () => {
    // ESLint 8 exposes no bundled TypeScript declarations in this repository.
    const { ESLint } = require('eslint') as {
      ESLint: new (options: unknown) => {
        lintText: (text: string, options: { filePath: string }) => Promise<Array<{
          messages: Array<{ ruleId: string | null; message: string }>;
        }>>;
      };
    };
    const eslint = new ESLint({
      useEslintrc: false,
      ignore: false,
      baseConfig: {
        parser: '@typescript-eslint/parser',
        plugins: ['@typescript-eslint'],
        parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        rules: { '@typescript-eslint/consistent-type-imports': 'error' }
      }
    });
    const faulty = "import { SettingsManager } from './renderers'; export let manager: SettingsManager;";
    const corrected = faulty.replace('import {', 'import type {');
    const [before] = await eslint.lintText(faulty, { filePath: 'fixture.ts' });
    const [after] = await eslint.lintText(corrected, { filePath: 'fixture.ts' });
    expect(before.messages.map(item => item.ruleId)).toEqual(['@typescript-eslint/consistent-type-imports']);
    expect(after.messages).toEqual([]);
  });
});
