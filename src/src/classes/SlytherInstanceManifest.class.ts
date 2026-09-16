// Imports
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SlytherInstanceManifest {
    /** The name of the manifest inside the instances folder. */
    static readonly FILE = "manifest.json";

    private constructor(
        /** Where the manifest is written. */
        private readonly path: string,
        /** Every instance checked, keyed by `kind:name`: what deciding to check it again needs. */
        readonly instances: Record<
            string,
            {
                /** The hash of the code of the instance, as located, without where it is. */
                contentHash: string;
                /** The `key shape` lines of the instance when it was checked, if its kind prints them. */
                signature?: string[];
                /** What every instance it references looked like when it was evaluated. */
                dependencies: Record<string, { contentHash: string; signature?: string[] }>;
                /** The hash of the scripts and prompts it was evaluated with. */
                evaluatedWith: string;
                result: "pass" | "fail" | "missing";
                errors: string[];
            }
        >,
    ) {}

    /** The manifest at the path, or an empty one when there is none yet. */
    static async load(path: string): Promise<SlytherInstanceManifest> {
        try {
            return new SlytherInstanceManifest(path, JSON.parse(await readFile(path, "utf-8")).instances ?? {});
        } catch {
            return new SlytherInstanceManifest(path, {});
        }
    }

    /** Writes the manifest, with its instances sorted so it diffs well. */
    async save(): Promise<void> {
        const sorted = Object.fromEntries(Object.entries(this.instances).sort(([a], [b]) => a.localeCompare(b)));

        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify({ instances: sorted }, null, 4)}\n`);
    }
}
