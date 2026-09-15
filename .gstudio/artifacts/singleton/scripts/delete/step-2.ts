import { existsSync, unlinkSync } from "fs";
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
const filePath = join("src", "src", "singletons", `${name}.singleton.ts`);

if (!existsSync(filePath)) {
  console.error(`Error: singleton "${id}" does not exist (expected file at ${filePath}).`);
  process.exit(1);
}

unlinkSync(filePath);

console.log(`Deleted singleton at ${filePath}.`);
