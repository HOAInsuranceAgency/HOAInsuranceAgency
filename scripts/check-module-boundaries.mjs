import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../crm/package.json', import.meta.url));
const ts = require('typescript');
const normalized = value => value.replaceAll('\\', '/');
const within = (path, directory) => path === directory || path.startsWith(`${directory}/`);

export function inspectSource(source, filename, repository = root) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const local = normalized(relative(repository, filename));
  const shared = within(local, 'shared');
  const browser = within(local, 'crm/src') || within(local, 'web/src');
  const primitive = within(local, 'crm/src/components/ui');
  const server = within(local, 'crm/amplify/functions');
  const errors = [];
  const report = (node, message) => errors.push(`${local}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${message}`);
  function dependency(node, specifier, typeOnly = false) {
    if (!ts.isStringLiteralLike(specifier)) {
      if (shared) report(node, 'Shared modules require statically declared dependencies.');
      return;
    }
    const name = specifier.text;
    const target = name.startsWith('.') ? normalized(relative(repository, resolve(dirname(filename), name))) : name;
    if (shared && (!name.startsWith('.') || !within(target, 'shared'))) report(node, 'Shared business rules may depend only on other shared modules.');
    const executableServer = /^crm\/amplify\/(?:backend|(?:data|auth|storage)\/resource)(?:\.[cm]?[jt]s)?$/.test(target)
      || /^crm\/amplify\/functions\/.+\/handler(?:\.[cm]?[jt]s)?$/.test(target);
    if (browser && !typeOnly && executableServer) report(node, 'Browser code must not load server entrypoints; use a shared contract or type-only schema import.');
    if (primitive && name.startsWith('.') && !within(target, 'crm/src/components/ui')) report(node, 'UI primitives must not depend on feature or data modules.');
    if (server && /^crm\/src\/lib\/client(?:\.[cm]?[jt]sx?)?$/.test(target)) report(node, 'Server code must not import the browser SDK client.');
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
    if (shared && ts.isIdentifier(node) && ['window', 'localStorage', 'sessionStorage'].includes(node.text)) report(node, 'Shared business rules must not depend on browser state.');
    if (shared && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process' && node.name.text === 'env') report(node, 'Pass configuration into shared rules instead of reading process.env.');
    ts.forEachChild(node, visit);
  }
  visit(file);
  return errors;
}

export function moduleBoundaryViolations(repository = root) {
  function walk(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return ['node_modules', 'test', '__tests__'].includes(entry.name) ? [] : walk(path);
      return /\.[cm]?[jt]sx?$/.test(path) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
        ? inspectSource(readFileSync(path, 'utf8'), path, repository) : [];
    });
  }
  return ['shared', 'crm/src', 'crm/amplify/functions', 'web/src'].flatMap(path => walk(join(repository, path)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const failures = moduleBoundaryViolations();
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  else console.log('Module boundaries passed.');
}
