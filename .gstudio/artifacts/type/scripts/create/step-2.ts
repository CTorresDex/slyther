import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

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

const [id, content] = process.argv.slice(2);

if (!id) {
    console.error("Missing required argument: id");
    process.exit(1);
}

const typeName = toPascalCase(id);

if (!typeName) {
    console.error(`Could not derive a valid type name from id "${id}"`);
    process.exit(1);
}

const filePath = `src/types/${typeName}.type.ts`;

if (existsSync(filePath)) {
    console.error(`Type already exists at ${filePath}`);
    process.exit(1);
}

const body = content && content.trim().length > 0 ? content : "    // type definition";

const fileContents = `// Imports

export type ${typeName} = {
${body}
}
`;

mkdirSync(dirname(filePath), { recursive: true });
writeFileSync(filePath, fileContents);

console.log(`Scaffolded type at ${filePath}`);
