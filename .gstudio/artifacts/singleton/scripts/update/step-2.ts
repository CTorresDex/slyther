import { existsSync } from "fs";
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
const filePath = join("src", "singletons", `${name}.singleton.ts`);

if (!existsSync(filePath)) {
  console.error(`Error: singleton does not exist at ${filePath}.`);
  process.exit(1);
}
