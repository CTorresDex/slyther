Now I'll output the script directly rather than writing a file, since the instructions require the raw script text as the response format.

```ts
import * as fs from "fs";
import * as path from "path";

const searchTerm = process.argv[2];

const typesDir = path.join("src", "src", "types");

if (!fs.existsSync(typesDir) || !fs.statSync(typesDir).isDirectory()) {
    process.exit(0);
}

const files = fs
    .readdirSync(typesDir)
    .filter((file) => file.endsWith(".type.ts"))
    .sort();

for (const file of files) {
    const filePath = path.join(typesDir, file);
    const content = fs.readFileSync(filePath, "utf-8");

    const match = content.match(/export type (\w+)\s*=/);
    if (!match) {
        continue;
    }

    const id = match[1];

    if (searchTerm && !content.includes(searchTerm)) {
        continue;
    }

    console.log(`[${id}]: [${filePath}]`);
}
