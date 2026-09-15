import * as fs from "node:fs";
import * as path from "node:path";

const searchTerm = process.argv[2];

const classesDir = path.join(process.cwd(), "src", "classes");

if (!fs.existsSync(classesDir)) {
    process.exit(0);
}

const entries = fs
    .readdirSync(classesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".class.ts"))
    .map((entry) => entry.name)
    .sort();

for (const fileName of entries) {
    const id = fileName.slice(0, -".class.ts".length);
    const filePath = path.join("src", "classes", fileName);

    if (searchTerm) {
        const content = fs.readFileSync(path.join(classesDir, fileName), "utf-8");
        if (!content.includes(searchTerm)) {
            continue;
        }
    }

    console.log(`[${id}]: [${filePath}]`);
}
