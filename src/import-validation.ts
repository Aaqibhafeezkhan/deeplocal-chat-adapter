import ts from 'typescript';

export interface DuplicateImport {
  name: string;
  locations: Array<{ line: number; character: number }>;
}

interface ImportBinding {
  name: string;
  location: { line: number; character: number };
}

export function isTypeScriptPath(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/i.test(path);
}

function collectImports(path: string, content: string): Map<string, ImportBinding[]> {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ImportBinding[]>();
  const moduleOccurrences = new Map<string, number>();

  const add = (scope: string[], identifier: ts.Identifier): void => {
    // Parser recovery can synthesize missing identifiers; those are not bindings.
    if (!identifier.text || identifier.getWidth(source) === 0) {
      return;
    }
    const key = JSON.stringify([...scope, identifier.text]);
    const position = source.getLineAndCharacterOfPosition(identifier.getStart(source));
    const binding = {
      name: identifier.text,
      location: { line: position.line + 1, character: position.character + 1 }
    };
    const existing = bindings.get(key);
    if (existing) {
      existing.push(binding);
    } else {
      bindings.set(key, [binding]);
    }
  };

  const visit = (node: ts.Node, scope: string[]): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.name) {
        add(scope, clause.name);
      }
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          add(scope, clause.namedBindings.name);
        } else {
          for (const element of clause.namedBindings.elements) {
            add(scope, element.name);
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      add(scope, node.name);
    } else if (ts.isModuleDeclaration(node)) {
      // Merged ambient declarations still have independent import-local scopes.
      const name = `${ts.isStringLiteral(node.name) ? 'module' : 'namespace'}:${node.name.text}`;
      const key = JSON.stringify([...scope, name]);
      const occurrence = moduleOccurrences.get(key) ?? 0;
      moduleOccurrences.set(key, occurrence + 1);
      if (node.body) {
        visit(node.body, [...scope, name, String(occurrence)]);
      }
    } else if (ts.isSourceFile(node) || ts.isModuleBlock(node)) {
      for (const statement of node.statements) {
        visit(statement, scope);
      }
    }
  };

  visit(source, []);
  return bindings;
}

/** Find only new or worsened duplicate import bindings; never rewrite source. */
export function findNewDuplicateImports(path: string, original: string, candidate: string): DuplicateImport[] {
  if (!isTypeScriptPath(path)) {
    return [];
  }
  const before = collectImports(path, original);
  const after = collectImports(path, candidate);
  const duplicates: DuplicateImport[] = [];
  for (const [key, bindings] of after) {
    if (bindings.length > 1 && bindings.length > (before.get(key)?.length ?? 0)) {
      duplicates.push({ name: bindings[0].name, locations: bindings.map(binding => binding.location) });
    }
  }
  return duplicates;
}
