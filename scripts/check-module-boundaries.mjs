import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../crm/package.json', import.meta.url));
const ts = require('typescript');
const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const { parse: parseAstro } = webRequire('@astrojs/compiler/sync');
const normalized = value => value.replaceAll('\\', '/');
const within = (path, directory) => path === directory || path.startsWith(`${directory}/`);

export function inspectSource(source, filename, repository = root) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const local = normalized(relative(repository, filename));
  const shared = within(local, 'shared');
  const browser = within(local, 'crm/src') || within(local, 'web/src');
  const primitive = within(local, 'crm/src/components/ui');
  const server = within(local, 'crm/amplify');
  const errors = [];
  const report = (node, message) => errors.push(`${local}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${message}`);
  function dependency(node, specifier, typeOnly = false) {
    const literal = ts.isStringLiteralLike(specifier);
    const prefix = !shared && ts.isTemplateExpression(specifier) ? specifier.head.text : undefined;
    if (!literal && !prefix) {
      if (shared || browser || server) report(node, 'Use statically declared module paths or an explicit import map.');
      return;
    }
    const name = literal ? specifier.text : prefix;
    const target = name.startsWith('.') ? normalized(relative(repository, resolve(dirname(filename), name))) : name;
    if (shared && (!name.startsWith('.') || !within(target, 'shared'))) report(node, 'Shared business rules may depend only on other shared modules.');
    if (browser && !typeOnly && within(target, 'crm/amplify')) report(node, 'Browser code must not load server runtime modules; use a shared contract or type-only schema import.');
    if (browser && (['crm/fixtures', 'crm/scripts', 'crm/src/test', 'web/tests'].some(directory => within(target, directory)) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(target))) report(node, 'Production browser modules must not depend on test fixtures or preview tools.');
    if (primitive && name.startsWith('.') && !within(target, 'crm/src/components/ui')) report(node, 'UI primitives must not depend on feature or data modules.');
    if (server && within(target, 'crm/src')) report(node, 'Server code must not import frontend modules; use shared business rules.');
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = !!clause?.isTypeOnly || !clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly);
      dependency(node, node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const names = node.exportClause;
      const typeOnly = node.isTypeOnly || names && ts.isNamedExports(names) && names.elements.length > 0 && names.elements.every(item => item.isTypeOnly);
      dependency(node, node.moduleSpecifier, typeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) {
      dependency(node, node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      if (node.arguments[0]) dependency(node, node.arguments[0]);
    }
    if (shared && ts.isIdentifier(node) && ['process', 'globalThis', 'window', 'document', 'localStorage', 'sessionStorage', 'fetch', 'navigator', 'Buffer', 'require'].includes(node.text)) {
      const parent = node.parent;
      const property = ts.isPropertyAccessExpression(parent) && parent.name === node
        || ts.isPropertyAssignment(parent) && parent.name === node
        || ts.isPropertySignature(parent) && parent.name === node;
      if (!property) report(node, 'Shared business rules must not read platform state or perform platform IO.');
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return errors;
}

/** Astro frontmatter runs at build time; only executable script bodies are browser code. */
export function inspectFile(source, filename, repository = root) {
  if (!filename.endsWith('.astro')) return inspectSource(source, filename, repository);
  const failures = [];
  function visit(node) {
    if (node.type === 'element' && node.name === 'script') {
      const type = node.attributes.find(attribute => attribute.name === 'type');
      const inert = type && type.kind !== 'expression' && ['application/ld+json', 'application/json', 'importmap', 'speculationrules'].includes(type.value.trim().toLowerCase());
      if (!inert) {
        const src = node.attributes.find(attribute => attribute.name === 'src');
        if (src?.kind === 'quoted' && src.value) {
          const line = src.position.start.line;
          failures.push(...inspectSource('\n'.repeat(line - 1) + `import ${JSON.stringify(src.value)};`, filename, repository));
        }
        for (const child of node.children ?? []) {
          if (child.type === 'text') {
            const offset = child.position.start.offset;
            failures.push(...inspectSource(source.slice(0, offset).replace(/[^\n]/g, ' ') + child.value, filename, repository));
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(parseAstro(source, { position: true }).ast);
  return failures;
}

export function moduleBoundaryViolations(repository = root) {
  function walk(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return ['node_modules', 'test', '__tests__'].includes(entry.name) ? [] : walk(path);
      return /(?:\.[cm]?[jt]sx?|\.astro)$/.test(path) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
        ? inspectFile(readFileSync(path, 'utf8'), path, repository) : [];
    });
  }
  return ['shared', 'crm/src', 'crm/amplify', 'web/src'].flatMap(path => walk(join(repository, path)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const failures = moduleBoundaryViolations();
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  else console.log('Module boundaries passed.');
}
