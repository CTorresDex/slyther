import { existsSync } from "fs";
import { join } from "path";

function toPascalCase(id: string): string {
    return id
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join("");
}

const [id] = process.argv.slice(2);

if (!id) {
    console.error("Error: <id> argument is required.");
    process.exit(1);
}

const pascalName = toPascalCase(id);
const typePath = join("src", "types", `${pascalName}.type.ts`);

if (!existsSync(typePath)) {
    console.error(`Error: type "${id}" does not exist (expected file at ${typePath}).`);
    process.exit(1);
}
