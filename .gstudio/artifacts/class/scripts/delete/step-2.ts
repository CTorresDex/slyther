import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

function toPascalCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

function main(): void {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: step-2.ts <id>");
    process.exit(1);
  }

  const className = toPascalCase(id);
  const filePath = join("src", "classes", `${className}.class.ts`);

  if (!existsSync(filePath)) {
    console.error(`Class "${className}" does not exist at ${filePath}`);
    process.exit(1);
  }

  unlinkSync(filePath);
  console.log(`Deleted ${filePath}`);
}

main();
