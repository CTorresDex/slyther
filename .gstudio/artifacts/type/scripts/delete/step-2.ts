export {};

import * as fs from "fs";
import * as path from "path";

function toPascalCase(input: string): string {
    return input
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join("");
}

function main(): void {
    const id = process.argv[2];

    if (!id) {
        console.error("Error: missing required argument <id>.");
        process.exit(1);
    }

    const name = toPascalCase(id);

    if (!name) {
        console.error(`Error: could not derive a valid PascalCase name from "${id}".`);
        process.exit(1);
    }

    const dir = path.join("src", "src", "types");
    const filePath = path.join(dir, `${name}.type.ts`);

    if (!fs.existsSync(filePath)) {
        console.error(`Error: type does not exist at ${filePath}.`);
        process.exit(1);
    }

    fs.unlinkSync(filePath);
    console.log(`Deleted ${filePath}`);
}

main();
