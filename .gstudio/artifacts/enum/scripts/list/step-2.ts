import * as fs from "fs";
import * as path from "path";

const searchTerm = process.argv[2];

const enumsDir = path.join("src", "src", "enums");

if (!fs.existsSync(enumsDir) || !fs.statSync(enumsDir).isDirectory()) {
    process.exit(0);
}

const files = fs
    .readdirSync(enumsDir)
    .filter((file) => file.endsWith(".enum.ts"))
    .sort();

for (const file of files) {
    const filePath = path.join(enumsDir, file);
    const content = fs.readFileSync(filePath, "utf-8");

    const match = content.match(/export enum (\w+)\s*\{/);
    if (!match) {
        continue;
    }

    const id = match[1];

    if (searchTerm && !id.includes(searchTerm)) {
        continue;
    }

    console.log(`[${id}]: [${filePath}]`);
}
