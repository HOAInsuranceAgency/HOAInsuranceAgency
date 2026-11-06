// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type Rule } from 'postcss';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nativeControls = new Set(['button', 'input', 'select', 'textarea', 'table']);
const sharedRoots = new Set([
  'ui-button', 'ui-input', 'ui-select', 'ui-textarea', 'ui-table', 'ui-tabs', 'ui-segmented-control',
  'ui-tabs__tab', 'ui-segmented-control__option', 'ui-segmented-control__radio',
  'ui-suggestion-list', 'ui-suggestion-option',
  'ui-metric-button', 'ui-field',
]);
const chrome = /^(?:font(?:-.+)?|line-height|color|text-transform|letter-spacing|text-decoration(?:-.+)?|text-shadow|padding(?:-.+)?|border(?:-.+)?|background(?:-.+)?|(?:-\w+-)?(?:appearance|filter|backdrop-filter)|opacity|(?:min-)?height|(?:min-)?block-size|outline(?:-.+)?|box-shadow|--control-(?:radius|height|font)(?:-.+)?|--field-(?:height|font))$/;
const componentTags: Record<string, readonly string[]> = {
  Button: ['button'], ButtonLink: ['a'], ButtonSummary: ['summary'], Input: ['input'], Select: ['select'],
  Textarea: ['textarea'], Table: ['table'], Tabs: ['div'], SegmentedControl: ['div'], SegmentedRadioControl: ['div'], FilePicker: ['label'],
  SuggestionList: ['div'], SuggestionOption: ['div'],
  MetricButton: ['button'], Field: ['div'],
};
type ControlClasses = { names: Set<string>; tags: readonly string[] }[];

function productionFiles(directory = sourceRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name), local = relative(sourceRoot, path).replaceAll('\\', '/');
    if (local === 'components/ui' || /(?:^|\/)(?:test|__tests__)(?:\/|$)/.test(local)) return [];
    if (entry.isDirectory()) return productionFiles(path);
    return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [] : [path];
  });
}

function nativeJsx(source: string, filename: string): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
      const tag=node.tagName.text;
      const buttonRole=['div','span'].includes(tag)&&node.attributes.properties.some(attribute=>
        ts.isJsxAttribute(attribute)&&attribute.name.getText(file)==='role'&&!!attribute.initializer&&staticClasses(attribute.initializer).includes('button'));
      if(nativeControls.has(tag)||buttonRole)found.push(`${filename}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} <${tag}${buttonRole?' role="button"':''}>`);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

/** Only literal class pieces are collected; labels in a condition/event are not classes. */
function staticClasses(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.split(/\s+/).filter(Boolean);
  if (ts.isJsxExpression(node)) return node.expression ? staticClasses(node.expression) : [];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return staticClasses(node.expression);
  if (ts.isConditionalExpression(node)) return [...staticClasses(node.whenTrue), ...staticClasses(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return staticClasses(node.right);
    if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) return [...staticClasses(node.left), ...staticClasses(node.right)];
  }
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map(span => span.literal.text)]
    .flatMap(text => text.split(/\s+/)).filter(Boolean).concat(node.templateSpans.flatMap(span => staticClasses(span.expression)));
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(staticClasses);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['join', 'filter'].includes(node.expression.name.text)) return staticClasses(node.expression.expression);
  return [];
}

function sharedImports(file:ts.SourceFile) {
  const imports = new Map<string, readonly string[]>(), namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !/(?:^|\/)ui(?:\/|$)/.test(statement.moduleSpecifier.text)) continue;
    const bindings=statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      const tags=componentTags[item.propertyName?.text??item.name.text];
      if(tags)imports.set(item.name.text,tags);
    }
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    const defaultName=statement.importClause?.name, moduleName=statement.moduleSpecifier.text.split('/').at(-1)!;
    if(defaultName&&componentTags[moduleName])imports.set(defaultName.text,componentTags[moduleName]);
  }
  return (tag:ts.JsxTagNameExpression)=>ts.isIdentifier(tag)?imports.get(tag.text)
    :ts.isPropertyAccessExpression(tag)&&ts.isIdentifier(tag.expression)&&namespaces.has(tag.expression.text)?componentTags[tag.name.text]:undefined;
}

function controlClasses(source: string, filename: string): ControlClasses {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imported=sharedImports(file), classes:ControlClasses=[];
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tags=imported(node.tagName);
      if(tags)for(const attribute of node.attributes.properties) {
        if(ts.isJsxAttribute(attribute)&&attribute.name.getText(file)==='className'&&attribute.initializer) {
          const names=new Set(staticClasses(attribute.initializer).filter(name=>/^[a-zA-Z_-][\w-]*$/.test(name)));
          if(names.size)classes.push({names,tags});
        }
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(file);
  return classes;
}

const layoutProperty=/^(?:width|min-width|max-width|margin(?:-.+)?|position|inset(?:-.+)?|top|right|bottom|left|display|visibility|flex(?:-.+)?|align(?:-.+)?|justify(?:-.+)?|gap|row-gap|column-gap|order|grid(?:-.+)?|vertical-align|text-align|white-space|box-sizing|overflow(?:-.+)?|z-index|transform(?:-origin)?|--control-padding-inline-(?:start|end))$/;
const cssProperty=(name:string)=>name.startsWith('--')?name:name.replace(/[A-Z]/g,letter=>`-${letter.toLowerCase()}`).replace(/^ms-/,'-ms-');

/** Style values can vary; every property key must be explicit and layout-only. */
function inlineControlStyles(source:string,filename:string):string[] {
  const file=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX), imported=sharedImports(file), found:string[]=[];
  const report=(node:ts.Node,detail:string)=>found.push(`${filename}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line+1} ${detail}`);
  function inspect(node:ts.Expression) {
    if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isNonNullExpression(node))return inspect(node.expression);
    if(node.kind===ts.SyntaxKind.NullKeyword||node.kind===ts.SyntaxKind.FalseKeyword||ts.isIdentifier(node)&&node.text==='undefined')return;
    if(ts.isConditionalExpression(node)){inspect(node.whenTrue);inspect(node.whenFalse);return;}
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken){inspect(node.right);return;}
    if(!ts.isObjectLiteralExpression(node)){report(node,'style keys must be explicit; use a layout class or shared variant instead of an unknown style expression');return;}
    for(const property of node.properties) {
      if(ts.isSpreadAssignment(property)){inspect(property.expression);continue;}
      const key=property.name;
      const name=ts.isIdentifier(key)||ts.isStringLiteral(key)||ts.isNumericLiteral(key)?key.text
        :ts.isComputedPropertyName(key)&&(ts.isStringLiteral(key.expression)||ts.isNoSubstitutionTemplateLiteral(key.expression))?key.expression.text:undefined;
      if(name===undefined){report(property,'computed style keys must be explicit; use a layout class or shared variant');continue;}
      const normalized=cssProperty(name);
      if(chrome.test(normalized)||!layoutProperty.test(normalized))report(property,`style ${name} (${normalized}) belongs in a shared component/variant; inline feature styles must be layout-only`);
    }
  }
  function visit(node:ts.Node) {
    if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&imported(node.tagName))for(const attribute of node.attributes.properties) {
      if(ts.isJsxAttribute(attribute)&&attribute.name.getText(file)==='style') {
        if(attribute.initializer&&ts.isJsxExpression(attribute.initializer)&&attribute.initializer.expression)inspect(attribute.initializer.expression);
        else report(attribute,'style must be an explicit layout-only object');
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(file);return found;
}

/** Split selector lists/combinators only outside strings, attributes and functions. */
function splitSelector(value: string, separator: 'list' | 'compound'): string[] {
  const output: string[] = []; let start = 0, parentheses = 0, brackets = 0, quote = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\') { i++; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[') brackets++;
    else if (char === ']') brackets--;
    else if (!brackets && char === '(') parentheses++;
    else if (!brackets && char === ')') parentheses--;
    const split = !brackets && !parentheses && (separator === 'list' ? char === ',' : /\s|[>+~]/.test(char) || value.slice(i, i + 2) === '||');
    if (split) { if (value.slice(start, i).trim()) output.push(value.slice(start, i).trim()); start = i + 1; }
  }
  if (value.slice(start).trim()) output.push(value.slice(start).trim());
  return output;
}

function closingParenthesis(value: string, opening: number): number {
  let depth = 1, quote = '', brackets = 0;
  for (let i = opening + 1; i < value.length; i++) {
    const char = value[i];
    if (char === '\\') { i++; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[') brackets++;
    else if (char === ']') brackets--;
    else if (!brackets && char === '(') depth++;
    else if (!brackets && char === ')' && --depth === 0) return i;
  }
  throw new Error(`Unbalanced selector function: ${value}`);
}

function directlyTargetsControl(selector: string, classes: ControlClasses = []): boolean {
  const subject = splitSelector(selector, 'compound').at(-1) ?? '';
  // Generated icons/content are not the control's own box. Placeholder and
  // file-selector-button styling still belong to the shared field recipe.
  const tag = /^(?:[\w*-]+\|)?([a-z][\w-]*)/i.exec(subject)?.[1]?.toLowerCase();
  let targets = !!tag && nativeControls.has(tag);
  const names:string[]=[], alternatives:string[]=[];
  for (let i = 0; i < subject.length; i++) {
    if (subject[i] === '[') {
      let quote = '';
      for (i++; i < subject.length; i++) {
        if (subject[i] === '\\') { i++; continue; }
        if (quote) { if (subject[i] === quote) quote = ''; }
        else if (subject[i] === '"' || subject[i] === "'") quote = subject[i];
        else if (subject[i] === ']') break;
      }
    } else if (subject[i] === '.') {
      const name = /^[\w-]+/.exec(subject.slice(i + 1))?.[0];
      if(name)names.push(name);
      if(name&&sharedRoots.has(name))targets=true;
    } else if (subject[i] === ':') {
      const generated = /^::(before|after|marker|selection)\b/.exec(subject.slice(i));
      if (generated) return false;
      const pseudo = /^:([\w-]+)\(/.exec(subject.slice(i));
      if (pseudo) {
        const opening = i + pseudo[0].length - 1, end = closingParenthesis(subject, opening);
        if (['is', 'where', 'matches', '-webkit-any', '-moz-any'].includes(pseudo[1])) alternatives.push(...splitSelector(subject.slice(opening + 1, end), 'list'));
        // :has and :not describe descendants/exclusions, not a direct control.
        i = end;
      }
    }
  }
  // A generic state such as .on does not make .suggestion.on a shared control:
  // every class in this subject must coexist on one known control root.
  const compatible=classes.filter(control=>(!tag||control.tags.includes(tag))&&names.every(name=>control.names.has(name)));
  return targets || names.length>0&&compatible.length>0 || alternatives.some(selector=>directlyTargetsControl(selector,compatible));
}

function resolvedSelectors(rule: Rule): string[] {
  const own = splitSelector(rule.selector, 'list');
  if (rule.parent?.type !== 'rule') return own;
  const parents = resolvedSelectors(rule.parent as Rule);
  return parents.flatMap(parent => own.map(child => child.includes('&') ? child.replaceAll('&', parent) : `${parent} ${child}`));
}

function controlChrome(source: string, filename: string, classes: ControlClasses = []): string[] {
  const found: string[] = [];
  parse(source, { from: filename }).walkRules(rule => {
    const targets = resolvedSelectors(rule).filter(selector=>directlyTargetsControl(selector,classes));
    if (!targets.length) return;
    rule.each(node => {
      if (node.type === 'decl' && chrome.test(node.prop.toLowerCase())) found.push(
        `${filename}:${node.source?.start?.line ?? 1} ${targets.join(', ')} → ${node.prop}`,
      );
    });
  });
  return found;
}

describe('shared control architecture', () => {
  it('recognizes native JSX but does not confuse shared components, strings or comments with native elements', () => {
    expect(nativeJsx('const field = <><Input /><Button /><Table /><input /><button>Save</button><select /><textarea /><table /></>;', 'sample.tsx')).toHaveLength(5);
    expect(nativeJsx('const text = "<button>"; /* <input /> */ const component = <UI.Input />;', 'sample.tsx')).toEqual([]);
    expect(nativeJsx('const metric=<><div role="button" /><span role={active ? "button" : undefined} /><svg role="button" /><MetricButton /></>;','sample.tsx')).toHaveLength(2);
  });

  it('recognizes direct control chrome through selector lists, functional selectors, attributes and CSS nesting', () => {
    expect(controlChrome(`
      .form :is(input, select):not([disabled]) { padding: 4px; }
      :where(.ui-button, .ui-select):hover { border-color: red; }
      .panel { & > textarea { min-height: 30px; } }
      button[data-label="svg, span"] { font-size: 10px; }
      .ui-tabs__tab[aria-selected=true] { background: red; }
      button:has(span::before), input[title="::before"] { padding: 2px; }
      .ui-suggestion-option[aria-selected=true] { background: blue; }
    `, 'sample.css')).toHaveLength(7);
  });

  it('allows layout, content/status descendants, relational selectors and provider popup or SVG/canvas styles', () => {
    expect(controlChrome(`
      .form input, .ui-table { width: 100%; max-width: 300px; margin: 4px; position: relative; }
      .ui-button > span, button svg, .ui-table td, .ui-tabs .count { font-size: 12px; padding: 2px; }
      .panel:has(button), .panel:not(input) { padding: 16px; }
      .pac-container, .pac-item, svg, canvas { border: 1px solid red; height: 40px; }
      .ui-button::before { background: red; height: 8px; }
    `, 'sample.css')).toEqual([]);
  });

  it('catches chrome hidden behind custom shared-control classes, including aliases and conditional/template classes', () => {
    const classes=controlClasses(`
      import { Button as Save, ButtonLink } from './components/ui/Button';
      import * as Fields from './components/ui/Input';
      import { SuggestionOption } from './components/ui/SuggestionList';
      const view=<><Save className={active ? 'my-button selected' : 'my-button'} /><ButtonLink className="nav-action" />
        <Fields.Input className={\`search-field \${invalid && 'invalid-field'}\`} /><SuggestionOption className="custom-suggestion" /><div className="content-only" /></>;
    `,'sample.tsx');
    expect([...new Set(classes.flatMap(control=>[...control.names]))].sort()).toEqual(['custom-suggestion','invalid-field','my-button','nav-action','search-field','selected']);
    expect(controlChrome('.my-button:hover { opacity: .5; color: red; } .search-field { filter: grayscale(1); padding: 2px; } a.nav-action { background: red; } .custom-suggestion { padding: 4px; }','sample.css',classes)).toHaveLength(6);
    expect(controlChrome('.my-button { width: 100%; margin: 5px; } .my-button span, span.my-button, .nav-action svg, .content-only, .panel:has(.my-button) { opacity: .5; padding: 4px; color: red; }','sample.css',classes)).toEqual([]);
  });

  it('does not confuse component-owned suggestion/row state with an unrelated control sharing a generic class', () => {
    const classes=controlClasses(`import { Button } from './ui/Button';
      const view=<><Button className="filter-option on" /><div className="usearch-hit on" role="option" />
      <div className="usearch-foot on" /><tr className="summary-row on" /></>;`,'sample.tsx');
    expect(controlChrome('.usearch-hit.on, .usearch-foot.on, .summary-row.on { background: blue; opacity: .8; }','sample.css',classes)).toEqual([]);
    expect(controlChrome('.filter-option.on, :is(.filter-option).on { background: blue; }','sample.css',classes)).toHaveLength(1);
  });

  it('keeps field composition styling shared while allowing field layout classes', () => {
    const classes = controlClasses(`import { Field as FormField } from './ui/Field';
      const view=<FormField label="Name" className="contact-field full">{control=><Input {...control}/>}</FormField>;`, 'sample.tsx');
    expect(controlChrome('.contact-field { color: red; padding: 4px; } .ui-field { font-size: 10px; }', 'sample.css', classes)).toHaveLength(3);
    expect(controlChrome('.contact-field.full { grid-column: 1 / -1; min-width: 0; } .contact-field .error-text { color: red; }', 'sample.css', classes)).toEqual([]);
  });

  it('rejects inline visual styles on aliased, default and namespaced shared controls while leaving content styles alone', () => {
    const source=`import { Button as Save } from './ui/Button'; import Select from './ui/Select'; import * as Fields from './ui/Input';
      const view=<><Save style={{backgroundColor:'red',color:'white',borderRadius:0,padding:1}} />
      <Select style={{fontSize:11,height:20}} /><Fields.Input style={{WebkitAppearance:'none'}} />
      <span style={{color:'red',fontWeight:700}}>Status content</span></>;`;
    const violations=inlineControlStyles(source,'sample.tsx');
    expect(violations).toHaveLength(7);
    expect(violations.join('\n')).toContain('background-color');expect(violations.join('\n')).toContain('-webkit-appearance');
    expect(violations.join('\n')).not.toContain('fontWeight');
  });

  it('allows explicit layout keys with dynamic values, but rejects opaque, spread and computed style bypasses', () => {
    const prefix=`import { Button } from './ui/Button';`;
    expect(inlineControlStyles(`${prefix} const view=<Button style={active?{minWidth:width,marginTop:12}:{width:'100%',alignSelf:'start',...{marginInline:2}}} />;`,'sample.tsx')).toEqual([]);
    expect(inlineControlStyles(`${prefix} const view=<><Button style={unknownStyle}/><Button style={{...unknownStyle}}/><Button style={{[property]:'red'}}/><Button style={getStyle()}/><Button style={{['color']:'red'}}/></>;`,'sample.tsx')).toHaveLength(5);
  });

  it('routes every production native control through a shared primitive', () => {
    const violations = productionFiles().filter(path => /\.[cm]?[jt]sx?$/.test(path)).flatMap(path =>
      nativeJsx(readFileSync(path, 'utf8'), relative(sourceRoot, path)),
    );
    expect(violations.length, `Use shared controls from components/ui:\n${violations.join('\n')}`).toBe(0);
  });

  it('keeps inline shared-control styles explicit and layout-only in production feature code', () => {
    const violations=productionFiles().filter(path=>/\.[cm]?[jt]sx?$/.test(path)).flatMap(path=>
      inlineControlStyles(readFileSync(path,'utf8'),relative(sourceRoot,path)),
    );
    expect(violations.length,`Use shared variants or explicit layout classes:\n${violations.join('\n')}`).toBe(0);
  });

  it('keeps control visual recipes inside components/ui while allowing consumer layout and content styling', () => {
    const files=productionFiles(), classes=files.filter(path=>/\.[cm]?[jt]sx?$/.test(path))
      .flatMap(path=>controlClasses(readFileSync(path,'utf8'),relative(sourceRoot,path)));
    const violations = files.filter(path => path.endsWith('.css')).flatMap(path =>
      controlChrome(readFileSync(path, 'utf8'), relative(sourceRoot, path),classes),
    );
    expect(violations.length, `Move control chrome into components/ui variants:\n${violations.join('\n')}`).toBe(0);
  });
});
