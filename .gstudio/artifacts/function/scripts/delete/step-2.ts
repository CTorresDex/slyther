import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

function toCamelCase(input: string): string {
  return input
    .replace(/[-_\s]+(.)?/g, (_match, chr: string | undefined) =>
      chr ? chr.toUpperCase() : ""
    )
    .replace(/^(.)/, (chr) => chr.toLowerCase());
}

function main(): void {
  const id = process.argv[2];

  if (!id) {
    console.error("Missing required argument: <id>");
    process.exit(1);
  }

  const name = toCamelCase(id);
  const filePath = join("src", "functions", `${name}.function.ts`);

  if (!existsSync(filePath)) {
    console.error(`Function "${id}" does not exist at ${filePath}`);
    process.exit(1);
  }

  unlinkSync(filePath);
  console.log(`Deleted ${filePath}`);
}

main();
