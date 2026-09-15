I don't have permission to write to that file in this environment. Per the task instructions, I'll output the script contents directly instead.

import { existsSync } from "fs";
import { join } from "path";

function toPascalCase(input: string): string {
    return input
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((word) => {
            if (/^[A-Z0-9]+$/.test(word)) {
                return word.charAt(0) + word.slice(1).toLowerCase();
            }
            const parts = word.split(/(?=[A-Z])/);
            return parts
                .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
                .join("");
        })
        .join("");
}

function main() {
    const [id] = process.argv.slice(2);

    if (!id) {
        console.error("Error: missing required argument <id>.");
        process.exit(1);
    }

    const className = toPascalCase(id);
    const classPath = join("src", "src", "classes", `${className}.class.ts`);

    if (!existsSync(classPath)) {
        console.error(`Error: class "${id}" does not exist (expected file at ${classPath}).`);
        process.exit(1);
    }
}

main();
