import * as fs from 'fs';
import * as path from 'path';

const searchTerm = process.argv[2];

const functionsDir = path.join(process.cwd(), 'src', 'functions');

let files: string[] = [];
try {
  files = fs.readdirSync(functionsDir).filter((f) => f.endsWith('.function.ts'));
} catch (err) {
  files = [];
}

const results: { id: string; filePath: string }[] = [];

for (const file of files) {
  const absolutePath = path.join(functionsDir, file);
  let content: string;
  try {
    content = fs.readFileSync(absolutePath, 'utf-8');
  } catch (err) {
    console.error(`Failed to read file: ${absolutePath}`);
    process.exit(1);
  }

  if (searchTerm && !content.includes(searchTerm)) {
    continue;
  }

  const id = file.slice(0, -'.function.ts'.length);
  results.push({ id, filePath: path.relative(process.cwd(), absolutePath) });
}

results.sort((a, b) => a.id.localeCompare(b.id));

for (const result of results) {
  console.log(`[${result.id}]: [${result.filePath}]`);
}
