import { readdirSync, statSync } from "fs";
import { join } from "path";

const TYPES_DIR = "src/types";
const FILE_SUFFIX = ".type.ts";

function toId(pascalName: string): string {
    return pascalName.replace(/(?!^)([A-Z])/g, "-$1").toLowerCase();
}

function main(): void {
    const searchTerm = process.argv[2];

    let entries: string[] = [];
    try {
        entries = readdirSync(TYPES_DIR);
    } catch {
        return;
    }

    for (const entry of entries) {
        const fullPath = join(TYPES_DIR, entry);
        if (!statSync(fullPath).isFile()) continue;
        if (!entry.endsWith(FILE_SUFFIX)) continue;

        const pascalName = entry.slice(0, -FILE_SUFFIX.length);
        const id = toId(pascalName);

        if (searchTerm && !id.includes(searchTerm.toLowerCase())) continue;

        console.log(`[${id}]: ${fullPath}`);
    }
}

main();
