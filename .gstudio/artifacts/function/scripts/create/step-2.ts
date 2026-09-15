import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

function toCamelCase(input: string): string {
  return input
    .replace(/[_-]+(.)/g, (_, chr: string) => chr.toUpperCase())
    .replace(/^[A-Z]/, (chr) => chr.toLowerCase());
}

const id = process.argv[2];

if (!id) {
  console.error("Error: missing required argument <id>.");
  process.exit(1);
}

const name = toCamelCase(id);
const dir = join("src", "functions");
const filePath = join(dir, `${name}.function.ts`);

if (existsSync(filePath)) {
  console.error(`Error: function already exists at ${filePath}.`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });

const contents = `// Imports

export function ${name}() {
    // function definition
}
`;

writeFileSync(filePath, contents);

console.log(`Scaffolded function at ${filePath}.`);
