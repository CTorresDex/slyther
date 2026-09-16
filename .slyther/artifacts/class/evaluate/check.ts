#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

type Finding = { code: string; message: string };

const CLASSES_DIR = join('src', 'src', 'classes');

function toPascalCase(id: string): string {
  const parts = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((p) => p.length > 0);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

// The text that precedes the braces of an `import {...}` / `export {...}` clause. Such a
// brace group is part of the statement, not a block, so it must not end the statement.
const MODULE_CLAUSE = /(?:^|[\n;])\s*(?:import|export)\s+type\s*$|(?:^|[\n;])\s*(?:import|export)\s*$/;

// A module statement that is already complete, i.e. it ends in its quoted specifier. Semicolons are
// optional in TypeScript, so such a statement also ends at the newline that follows it.
const MODULE_COMPLETE = /^\s*(?:import\b[\s\S]*|export\b[\s\S]*\bfrom\s*)(['"])[^'"]*\1\s*$/;

// Splits source into top-level statements. Strings, template literals and comments
// are skipped so braces inside them do not affect nesting depth.
function topLevelStatements(source: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  let moduleClause = false;
  let i = 0;
  const n = source.length;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) statements.push(trimmed);
    current = '';
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // Line comment
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Quoted strings
    if (ch === '\'' || ch === '"') {
      const quote = ch;
      let s = ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') { s += source[i]; i++; }
        if (i < n) { s += source[i]; i++; }
      }
      s += quote;
      i++;
      if (depth === 0) current += s;
      continue;
    }
    // Template literals (with nested ${} tracking)
    if (ch === '`') {
      let s = '`';
      i++;
      let exprDepth = 0;
      while (i < n) {
        const c = source[i];
        if (c === '\\') { s += c + (source[i + 1] ?? ''); i += 2; continue; }
        if (exprDepth === 0 && c === '`') { s += c; i++; break; }
        if (c === '$' && source[i + 1] === '{') { exprDepth++; s += '${'; i += 2; continue; }
        if (exprDepth > 0 && c === '{') exprDepth++;
        if (exprDepth > 0 && c === '}') exprDepth--;
        s += c;
        i++;
      }
      if (depth === 0) current += s;
      continue;
    }

    if (ch === '{' || ch === '(' || ch === '[') {
      if (depth === 0) {
        if (ch === '{') moduleClause = MODULE_CLAUSE.test(current);
        current += ch;
      }
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        current += ch;
        if (ch === '}' && !moduleClause) {
          // Swallow an optional trailing semicolon after a block
          let j = i + 1;
          while (j < n && (source[j] === ' ' || source[j] === '\t')) j++;
          if (source[j] === ';') i = j;
          push();
        }
        if (ch === '}') moduleClause = false;
      }
      i++;
      continue;
    }
    if (depth === 0) {
      if (ch === ';') {
        push();
        i++;
        continue;
      }
      if (ch === '\n' && MODULE_COMPLETE.test(current)) {
        push();
        i++;
        continue;
      }
      current += ch;
    }
    i++;
  }
  push();

  // Imports without semicolons may have merged; split them on lines starting with `import`.
  const result: string[] = [];
  for (const st of statements) {
    const lines = st.split('\n');
    let acc = '';
    for (const line of lines) {
      if (/^\s*import\s/.test(line) && acc.trim().length > 0) {
        result.push(acc.trim());
        acc = '';
      }
      acc += (acc ? '\n' : '') + line;
    }
    if (acc.trim().length > 0) result.push(acc.trim());
  }

  // Attach decorators to the statement that follows them.
  const merged: string[] = [];
  let pendingDecorators = '';
  for (const st of result) {
    if (/^@/.test(st) && !/\bclass\b/.test(st)) {
      pendingDecorators += (pendingDecorators ? '\n' : '') + st;
      continue;
    }
    merged.push(pendingDecorators ? pendingDecorators + '\n' + st : st);
    pendingDecorators = '';
  }
  if (pendingDecorators) merged.push(pendingDecorators);
  return merged;
}

function describe(statement: string): string {
  const firstLine = statement.split('\n')[0].trim();
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
}

function evaluateClass(id: string, findings: Finding[]): void {
  const name = toPascalCase(id);
  if (name.length === 0) {
    findings.push({ code: 'INVALID_CLASS_ID', message: `Class id "${id}" cannot be converted to a PascalCase name` });
    return;
  }
  const relPath = join(CLASSES_DIR, `${name}.class.ts`);
  const absPath = join(process.cwd(), relPath);

  if (!existsSync(absPath)) {
    findings.push({ code: 'CLASS_FILE_MISSING', message: `Class "${id}" must be defined at ${relPath}` });
    return;
  }

  let source: string;
  try {
    source = readFileSync(absPath, 'utf8');
  } catch (err) {
    findings.push({ code: 'CLASS_FILE_UNREADABLE', message: `Could not read ${relPath}: ${(err as Error).message}` });
    return;
  }

  const statements = topLevelStatements(source);
  const classPattern = /^(?:@[\s\S]*?\n)?export\s+class\s+([A-Za-z_$][\w$]*)/;
  const anyClassPattern = /^(?:@[\s\S]*?\n)?(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;

  let classCount = 0;
  let sawClass = false;

  for (const st of statements) {
    if (/^import\s/.test(st)) {
      if (sawClass) {
        findings.push({ code: 'INVALID_SHAPE', message: `${relPath}: import found after the class definition; all imports must precede the class ("${describe(st)}")` });
      }
      continue;
    }

    const classMatch = st.match(anyClassPattern);
    if (classMatch) {
      classCount++;
      sawClass = true;
      const found = classMatch[1];
      if (classCount > 1) {
        findings.push({ code: 'MULTIPLE_TOP_LEVEL_DEFINITIONS', message: `${relPath}: more than one class is defined at the top level (found "${found}")` });
        continue;
      }
      if (!classPattern.test(st)) {
        findings.push({ code: 'INVALID_SHAPE', message: `${relPath}: class "${found}" must be declared exactly as "export class ${name}" ("${describe(st)}")` });
      }
      if (found !== name) {
        findings.push({ code: 'CLASS_NAME_MISMATCH', message: `${relPath}: class is named "${found}" but must be named "${name}"` });
      }
      continue;
    }

    findings.push({ code: 'EXTRA_TOP_LEVEL_DEFINITION', message: `${relPath}: only the class may be defined at the top level, found "${describe(st)}"` });
  }

  if (classCount === 0) {
    findings.push({ code: 'CLASS_NOT_FOUND', message: `${relPath}: no top-level "export class ${name}" definition found` });
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('Usage: check <class-id> [<class-id> ...]\n');
    process.exit(1);
  }

  const findings: Finding[] = [];
  for (const id of args) {
    evaluateClass(id, findings);
  }

  if (findings.length === 0) {
    process.exit(0);
  }
  for (const f of findings) {
    process.stdout.write(`${f.code}: ${f.message}\n`);
  }
  process.exit(1);
}

main();
