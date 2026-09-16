// Imports
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SlytherManifest {
    private constructor(
        /** The file the manifest is kept in. */
        private readonly path: string,
        /** What was generated, by section then by key: the hash it was generated from and the text it produced. */
        private readonly entries: Record<string, Record<string, { hash: string; text: string }>>,
    ) {}

    /** The manifest kept at the path, or an empty one when there is none yet. */
    static async load(path: string): Promise<SlytherManifest> {
        try {
            return new SlytherManifest(path, JSON.parse(await readFile(path, "utf-8")));
        } catch {
            return new SlytherManifest(path, {});
        }
    }

    /** The text generated for the key, if it was generated from this very hash. */
    get(section: string, key: string, hash: string): string | undefined {
        const entry = this.entries[section]?.[key];

        return entry?.hash === hash ? entry.text : undefined;
    }

    /** Remembers the text generated for the key and the hash it was generated from. */
    set(section: string, key: string, hash: string, text: string): void {
        (this.entries[section] ??= {})[key] = { hash, text };
    }

    /** Forgets every key of a section that is not among the given ones, so removed artifacts leave no trace. */
    keep(section: string, keys: string[]): void {
        const kept = new Set(keys);

        for (const key of Object.keys(this.entries[section] ?? {})) {
            if (!kept.has(key)) {
                delete this.entries[section]![key];
            }
        }
    }

    /** Writes the manifest, sorted so its diffs are readable. */
    async save(): Promise<void> {
        const sorted = Object.fromEntries(
            Object.keys(this.entries)
                .sort()
                .map((section) => [
                    section,
                    Object.fromEntries(Object.entries(this.entries[section]!).sort(([a], [b]) => a.localeCompare(b))),
                ]),
        );

        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify(sorted, null, 4)}\n`);
    }
}
