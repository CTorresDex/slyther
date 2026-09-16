#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);

if (args.length !== 1 || !args[0] || !args[0].trim()) {
  process.stderr.write('Usage: scaffold <id>\n');
  process.exit(1);
}

const id = args[0].trim();

const parts = id.split(/[^A-Za-z0-9]+/).filter((p) => p.length > 0);
if (parts.length === 0) {
  process.stderr.write('Error: id "' + id + '" contains no alphanumeric characters\n');
  process.exit(1);
}

const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
  process.stderr.write('Error: id "' + id + '" cannot be converted to a valid PascalCase class name (got "' + name + '")\n');
  process.exit(1);
}

const filePath = join(process.cwd(), 'src', 'src', 'classes', name + '.class.ts');

if (existsSync(filePath)) {
  process.stderr.write('Error: class already exists at ' + filePath + '\n');
  process.exit(1);
}

const content = [
  '// Imports',
  '',
  'export class ' + name + ' {',
  '    // class definition',
  '}',
  '',
].join('\n');

try {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write('Error: failed to write ' + filePath + ': ' + message + '\n');
  process.exit(1);
}

process.exit(0);
