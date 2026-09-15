import * as fs from "fs";
import * as path from "path";

const FUNCTIONS_DIR = path.join("src", "src", "functions");
const FILE_SUFFIX = ".function.ts";

function main(): void {
  const searchTerm = process.argv[2];

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(FUNCTIONS_DIR);
  } catch {
    entries = [];
  }

  const results: { id: string; filePath: string }[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(FILE_SUFFIX)) continue;

    const filePath = path.join(FUNCTIONS_DIR, entry);
    if (!fs.statSync(filePath).isFile()) continue;

    const content = fs.readFileSync(filePath, "utf-8");
    if (searchTerm && !content.includes(searchTerm)) continue;

    const id = entry.slice(0, -FILE_SUFFIX.length);
    results.push({ id, filePath });
  }

  results.sort((a, b) => a.id.localeCompare(b.id));

  for (const result of results) {
    console.log(`[${result.id}]: [${result.filePath}]`);
  }
}

main();
