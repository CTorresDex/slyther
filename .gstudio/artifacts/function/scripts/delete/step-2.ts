import { existsSync, unlinkSync } from "fs";

function toCamelCase(input: string): string {
    return input
        .replace(/[_-]+/g, " ")
        .replace(/\s+(.)/g, (_, chr: string) => chr.toUpperCase())
        .replace(/\s/g, "")
        .replace(/^(.)/, (_, chr: string) => chr.toLowerCase());
}

const id = process.argv[2];

if (!id) {
    console.error("Usage: step-2.ts <id>");
    process.exit(1);
}

const name = toCamelCase(id);
const filePath = `src/src/functions/${name}.function.ts`;

if (!existsSync(filePath)) {
    console.error(`Function "${name}" does not exist at ${filePath}`);
    process.exit(1);
}

unlinkSync(filePath);
console.log(`Deleted ${filePath}`);
