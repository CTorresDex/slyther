import * as fs from "node:fs";
import * as path from "node:path";

function toPascalCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

function main(): void {
  const id = process.argv[2];

  if (!id) {
    console.error("Error: missing required argument <id>.");
    process.exit(1);
  }

  const className = toPascalCase(id);
  const filePath = path.join("src", "classes", `${className}.class.ts`);

  if (fs.existsSync(filePath)) {
    console.error(`Error: class already exists at ${filePath}.`);
    process.exit(1);
  }

  const content = `// Imports

export class ${className} {
    // class definition
}
`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);

  console.log(`Scaffolded class ${className} at ${filePath}.`);
}

main();
