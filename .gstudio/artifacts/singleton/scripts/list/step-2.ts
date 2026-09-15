import { readdirSync } from "fs";
import { join } from "path";

const searchTerm = process.argv[2];

const singletonsDir = join("src", "src", "singletons");
const suffix = ".singleton.ts";

let files: string[] = [];
try {
  files = readdirSync(singletonsDir);
} catch {
  files = [];
}

const entries = files
  .filter((file) => file.endsWith(suffix))
  .map((file) => {
    const id = file.slice(0, -suffix.length);
    const filePath = join(singletonsDir, file);
    return { id, filePath };
  })
  .filter(({ id }) => !searchTerm || id.includes(searchTerm))
  .sort((a, b) => a.id.localeCompare(b.id));

for (const { id, filePath } of entries) {
  console.log(`[${id}]: [${filePath}]`);
}
