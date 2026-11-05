import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '..');
type Layer = 'browser' | 'backend' | 'shared';
function within(file: string, directory: string) {
  const path = relative(directory, file);
  return path === '' || !path.startsWith('..') && !path.startsWith('/');
}
function violations(file: string, source: string, layer: Layer): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const problems: string[] = [];
  const report = (node: ts.Node, message: string) => problems.push(`${relative(root, file)}:${parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1} ${message}`);
  function dependency(node: ts.Node, specifier: string, typeOnly = false) {
    const target = resolve(dirname(file), specifier);
    if (layer === 'shared' && (!specifier.startsWith('.') || !within(target, resolve(root, 'shared')))) report(node, `shared code imports app/platform dependency ${specifier}`);
    if (layer === 'backend' && (within(target, resolve(root, 'crm/src')) || /(?:^|\/)src\//.test(specifier))) report(node, `backend imports frontend module ${specifier}`);
    if (layer === 'browser' && !typeOnly && (within(target, resolve(root, 'crm/amplify')) || /(?:^|\/)amplify\//.test(specifier))) report(node, `browser imports server runtime module ${specifier}`);
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly = !!clause?.isTypeOnly || !!clause && !clause.name && !!named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(item => item.isTypeOnly);
      dependency(node, node.moduleSpecifier.text, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.isTypeOnly || !!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly);
      dependency(node, node.moduleSpecifier.text, typeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      dependency(node, node.moduleReference.expression.text, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const argument = node.arguments[0];
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) dependency(node, argument.text);
      else if (layer === 'shared') report(node, 'shared code has a dynamic platform dependency');
      else if (argument && ts.isTemplateExpression(argument)) dependency(node, argument.head.text);
    }
    if (layer === 'shared' && ts.isIdentifier(node) && ['process', 'globalThis', 'window', 'document', 'localStorage', 'sessionStorage', 'fetch', 'navigator', 'Buffer', 'require'].includes(node.text)) {
      const parent = node.parent;
      if (!(ts.isPropertyAccessExpression(parent) && parent.name === node) && !(ts.isPropertyAssignment(parent) && parent.name === node) && !(ts.isPropertySignature(parent) && parent.name === node)) report(node, `shared code uses platform global ${node.text}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return problems;
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'test', 'dist', '.amplify'].includes(entry.name) ? [] : files(file);
    return /\.(?:ts|tsx|js|mjs|astro)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [file] : [];
  });
}

describe('cross-runtime business rule boundaries', () => {
  it.each([
    ['backend', 'crm/amplify'], ['browser', 'crm/src'], ['browser', 'web/src'], ['shared', 'shared'],
  ] as const)('keeps %s modules inside their allowed dependencies (%s)', (layer, directory) => {
    const problems = files(resolve(root, directory)).flatMap(file => {
      const source = readFileSync(file, 'utf8');
      // Astro imports live in frontmatter or script blocks, not page copy.
      const code = file.endsWith('.astro') ? [...source.matchAll(/(?:^---\s*\n([\s\S]*?)\n---|<script[^>]*>([\s\S]*?)<\/script>)/g)].map(match => match[1] ?? match[2]).join('\n') : source;
      return violations(file, code, layer);
    });
    expect(problems).toEqual([]);
  });

  it('rejects aliased imports, reexports and dynamic imports across runtime layers', () => {
    const backend = resolve(root, 'crm/amplify/functions/example.ts');
    expect(violations(backend, `import { rule as renamed } from '../../src/lib/rule';`, 'backend')).toHaveLength(1);
    const browser = resolve(root, 'crm/src/example.ts');
    expect(violations(browser, `export { rule } from '../amplify/functions/rule'; import('../amplify/functions/rule');`, 'browser')).toHaveLength(2);
    expect(violations(browser, `import { type Schema, handler } from '../amplify/data/resource';`, 'browser')).toHaveLength(1);
  });

  it('preserves generated schema type imports and ordinary shared rules', () => {
    const browser = resolve(root, 'crm/src/example.ts');
    expect(violations(browser, `import type { Schema } from '../amplify/data/resource'; import { type Other } from '../amplify/contracts'; import { rule } from '../../shared/rule';`, 'browser')).toEqual([]);
    expect(violations(resolve(root, 'shared/example.ts'), `import { rule } from './rule'; export const run = () => rule();`, 'shared')).toEqual([]);
  });

  it('prevents SDKs, browser state and environment reads from entering shared code', () => {
    const shared = resolve(root, 'shared/example.ts');
    expect(violations(shared, `import React from 'react'; import { Client } from '@aws-sdk/client-dynamodb'; import { rule } from '../crm/src/lib/rule'; const enabled = process.env.FLAG; fetch('/api');`, 'shared')).toHaveLength(5);
    expect(violations(shared, `const enabled = globalThis.process.env.FLAG;`, 'shared')).not.toEqual([]);
  });
});
