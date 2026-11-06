/** Package the built, fictional preview as one offline HTML file. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const folder = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(folder, 'dist');
const output = resolve(process.argv[2] ?? resolve(dist, 'HOA_Commission_Preview.html'));
const withinDist = path => {
  const resolved = resolve(dist, path.replace(/^\/+/, ''));
  const rel = relative(dist, resolved);
  if (rel.startsWith('..') || rel.includes(':')) throw new Error('Unexpected asset outside the preview build.');
  return resolved;
};
let html = await readFile(resolve(dist, 'index.html'), 'utf8');
const script = html.match(/<script\b[^>]*src="([^"]+\.js)"[^>]*><\/script>/);
const style = html.match(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/);
if (!script || !style) throw new Error('Build the isolated commission preview before packaging it.');
let js = await readFile(withinDist(script[1]), 'utf8');
let css = await readFile(withinDist(style[1]), 'utf8');
const logo = await readFile(resolve(folder, '../../public/logo.png'));
js = js.replaceAll('/logo.png', 'data:image/png;base64,' + logo.toString('base64'));
for (const match of [...css.matchAll(/url\((["']?)(\/[^)"']+)\1\)/g)]) {
  const bytes = await readFile(withinDist(match[2]));
  const type = match[2].endsWith('.woff2') ? 'font/woff2' : match[2].endsWith('.png') ? 'image/png' : undefined;
  if (!type) throw new Error('Unsupported offline asset: ' + match[2]);
  css = css.replaceAll(match[0], 'url("data:' + type + ';base64,' + bytes.toString('base64') + '")');
}
const ts = createRequire(import.meta.url)('typescript');
const parsed = ts.createSourceFile('preview.js', js, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
function checkDependencies(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isMetaProperty(node) || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
    throw new Error('The preview build unexpectedly contains a module dependency.');
  }
  ts.forEachChild(node, checkDependencies);
}
checkDependencies(parsed);
new Script(js);
const cssUrls = [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)];
if (cssUrls.some(m => !(m[1] ?? m[2] ?? m[3]).trim().startsWith('data:'))) throw new Error('The preview still needs an external stylesheet asset.');
html = html.replace(script[0], () => '<script>' + js.replace(/<\/script/gi, '<\\/script') + '</script>');
html = html.replace(style[0], () => '<style>' + css.replace(/<\/style/gi, '<\\/style') + '</style>');
// Execute only after the root element exists.
const embeddedScript = html.match(/<script>[\s\S]*<\/script>/)?.[0];
if (!embeddedScript) throw new Error('The packaged script is missing.');
html = html.replace(embeddedScript, '').replace('</body>', () => embeddedScript + '</body>');
if (/<script[^>]+src=|<link[^>]+href=/i.test(html)) throw new Error('The packaged preview still requires an external file.');
await mkdir(dirname(output), {recursive:true});
await writeFile(output, html);
console.log('Offline preview: ' + output);
