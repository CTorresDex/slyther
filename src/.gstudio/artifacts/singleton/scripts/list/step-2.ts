Following the same pattern as the existing `class` list script, adapted for singletons (`src/singletons/*.singleton.ts`).

```ts
import * as fs from "node:fs";
import * as path from "node:path";

const searchTerm = process.argv[2];

const singletonsDir = path.join(process.cwd(), "src", "singletons");

if (!fs.existsSync(singletonsDir)) {
    process.exit(0);
}

const entries = fs
    .readdirSync(singletonsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".singleton.ts"))
    .map((entry) => entry.name)
    .sort();

for (const fileName of entries) {
    const id = fileName.slice(0, -".singleton.ts".length);
    const filePath = path.join("src", "singletons", fileName);

    if (searchTerm) {
        const content = fs.readFileSync(path.join(singletonsDir, fileName), "utf-8");
        if (!content.includes(searchTerm)) {
            continue;
        }
    }

    console.log(`[${id}]: [${filePath}]`);
}
