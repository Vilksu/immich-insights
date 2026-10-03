import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const sourceDir = join(import.meta.dirname, '..', 'src');
const parse = file => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function packEntries(file, name) {
  const source = parse(join(sourceDir, file));
  const messages = new Map();
  const duplicates = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = property.name.text;
        if (messages.has(key)) duplicates.push(key);
        messages.set(key, property.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { messages, duplicates };
}

function registeredPacks() {
  const source = parse(join(sourceDir, 'i18n.tsx'));
  const imports = new Map();
  let registry;
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text.startsWith('./')) {
      for (const item of node.importClause?.namedBindings?.elements ?? []) imports.set(item.name.text, `${node.moduleSpecifier.text.slice(2)}.ts`);
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'localePacks') registry = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!registry || !ts.isObjectLiteralExpression(registry)) throw Error('Missing localePacks registry');
  const packs = new Map();
  for (const locale of registry.properties) {
    if (!ts.isPropertyAssignment(locale) || locale.name.text === 'en') continue;
    const messages = locale.initializer.properties.find(property => ts.isPropertyAssignment(property) && property.name.text === 'messages');
    const symbol = messages?.initializer.getText(source);
    const file = imports.get(symbol);
    if (!file) throw Error(`No imported translation module for ${locale.name.text}`);
    packs.set(locale.name.text, { file, ...packEntries(file, symbol) });
  }
  if (!packs.size) throw Error('No translated locale packs registered');
  return packs;
}

const packs = registeredPacks();
const referenceKeys = new Set(packs.values().next().value.messages.keys());
const used = new Set();
const localeFiles = new Set([...packs.values()].map(pack => pack.file));
for (const file of readdirSync(sourceDir).filter(name => /\.tsx?$/.test(name) && name !== 'i18n.tsx' && !localeFiles.has(name))) {
  const source = parse(join(sourceDir, file));
  function collectLiterals(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) used.add(node.text);
    else if (ts.isConditionalExpression(node)) { collectLiterals(node.whenTrue); collectLiterals(node.whenFalse); }
    else ts.forEachChild(node, collectLiterals);
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && node.arguments.length) collectLiterals(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(source);
}

const placeholders = value => new Set([...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]));
const errors = [];
for (const [locale, pack] of packs) {
  for (const key of pack.duplicates) errors.push(`${locale}: duplicate key ${key}`);
  for (const key of new Set([...used, ...referenceKeys])) if (!pack.messages.has(key)) errors.push(`${locale}: missing ${key}`);
  for (const key of pack.messages.keys()) if (!referenceKeys.has(key)) errors.push(`${locale}: extra ${key}`);
  for (const [source, translated] of pack.messages) {
    const expected = placeholders(source);
    const actual = placeholders(translated);
    if (expected.size !== actual.size || [...expected].some(key => !actual.has(key))) errors.push(`${locale}: placeholder mismatch in ${source}`);
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Translations complete: ${used.size} English UI phrases; ${[...packs].map(([code, pack]) => `${pack.messages.size} ${code}`).join(', ')} entries.`);
