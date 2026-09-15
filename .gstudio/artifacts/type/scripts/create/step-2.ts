#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";

function toPascalCase(input: string): string {
    const words = input
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[\s_\-]+/)
        .filter(Boolean);
    return words
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join("");
}

function main() {
    const id = process.argv[2];

    if (!id || id.trim().length === 0) {
        console.error("Error: missing required argument <id>.");
        process.exit(1);
    }

    const typeName = toPascalCase(id);
    const filePath = path.join("src", "src", "types", `${typeName}.type.ts`);

    if (fs.existsSync(filePath)) {
        console.error(`Error: type already exists at ${filePath}.`);
        process.exit(1);
    }

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    const content = `// Imports

export type ${typeName} = {
}
`;

    fs.writeFileSync(filePath, content);
    console.log(`Scaffolded type at ${filePath}.`);
}

main();
