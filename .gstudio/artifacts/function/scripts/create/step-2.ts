import * as fs from "fs";
import * as path from "path";

function toCamelCase(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) {
    return "";
  }

  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) {
        return lower;
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

function main() {
  const id = process.argv[2];

  if (!id) {
    console.error("Error: missing required argument <id>.");
    process.exit(1);
  }

  const name = toCamelCase(id);

  if (!name) {
    console.error(`Error: could not derive a valid function name from id "${id}".`);
    process.exit(1);
  }

  const filePath = path.join("src", "src", "functions", `${name}.function.ts`);

  if (fs.existsSync(filePath)) {
    console.error(`Error: function already exists at ${filePath}.`);
    process.exit(1);
  }

  const content = `export function ${name}() {
}
`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);

  console.log(`Created function "${name}" at ${filePath}.`);
}

main();
