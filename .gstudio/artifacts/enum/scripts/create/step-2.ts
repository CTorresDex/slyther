import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

function toPascalCase(id: string): string {
    return id
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((word) => {
            const withInitialSplit = word.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
            return withInitialSplit
                .split(/\s+/)
                .filter(Boolean)
                .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
                .join("");
        })
        .join("");
}

const id = process.argv[2];

if (!id) {
    console.error("Error: missing required argument <id>.");
    process.exit(1);
}

const enumName = toPascalCase(id);

if (!enumName) {
    console.error(`Error: could not derive a valid enum name from id "${id}".`);
    process.exit(1);
}

const filePath = join("src", "enums", `${enumName}.enum.ts`);

if (existsSync(filePath)) {
    console.error(`Error: enum already exists at ${filePath}.`);
    process.exit(1);
}

const contents = `export enum ${enumName} {
    // enum members
}
`;

mkdirSync(dirname(filePath), { recursive: true });
writeFileSync(filePath, contents);

console.log(`Scaffolded enum ${enumName} at ${filePath}.`);
