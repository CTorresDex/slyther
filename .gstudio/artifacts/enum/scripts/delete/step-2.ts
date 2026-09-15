import * as fs from "fs";
import * as path from "path";

function toPascalCase(id: string): string {
    return id
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((word) => {
            if (/^[A-Z0-9]/.test(word) && word === word.toUpperCase()) {
                return word.charAt(0) + word.slice(1).toLowerCase();
            }
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join("");
}

function main(): void {
    const id = process.argv[2];

    if (!id) {
        console.error("Error: missing required argument <id>.");
        process.exit(1);
    }

    const name = toPascalCase(id);
    const filePath = path.join("src", "enums", `${name}.enum.ts`);

    if (!fs.existsSync(filePath)) {
        console.error(`Error: enum "${id}" does not exist at ${filePath}.`);
        process.exit(1);
    }

    fs.unlinkSync(filePath);
    console.log(`Removed enum "${id}" at ${filePath}.`);
}

main();
