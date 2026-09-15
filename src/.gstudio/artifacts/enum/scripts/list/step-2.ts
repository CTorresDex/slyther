import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

const searchTerm = process.argv[2];

const enumsDir = join("src", "enums");

if (!existsSync(enumsDir)) {
    process.exit(0);
}

const entries = readdirSync(enumsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".enum.ts"))
    .map((entry) => entry.name)
    .sort();

for (const fileName of entries) {
    const id = fileName.slice(0, -".enum.ts".length);
    const filePath = join(enumsDir, fileName);

    if (searchTerm) {
        const content = readFileSync(filePath, "utf-8");
        if (!content.includes(searchTerm)) {
            continue;
        }
    }

    console.log(`[${id}]: [${filePath}]`);
}
