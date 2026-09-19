// Imports
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SlytherInstanceManifest {
    /** The name of the manifest inside the instances folder. */
    static readonly FILE = "manifest.json";
    /** What a manifest written by this version records, so an older one can be brought forward on load. */
    static readonly VERSION = 2;

    private constructor(
        /** Where the manifest is written. */
        private readonly path: string,
        /** The version the manifest on disk was written with: 1 is one written before the rules of a kind were recorded. */
        readonly version: number,
        /** Every instance checked, keyed by `kind:name`: what deciding to check it again needs. */
        readonly instances: Record<
            string,
            {
                /** The hash of the artifact that declares the instance and of what it leans on, so a change to its prose, its args or its rules is noticed. */
                specHash: string;
                /** The hash of the rules of its kind, so a change to them is noticed by every instance of it. Absent in a manifest written before version 2. */
                rulesHash?: string;
                /** The instance whose expand emitted it, when it was not declared by hand. */
                parent?: string;
                /** The args locate was run with, when it takes more than the id, so the instance can be found again once its declaration is gone or its args changed. */
                locatedWith?: string[];
                /** The hash of the code of the instance, as located, without where it is. */
                contentHash: string;
                /** The `key shape` lines of the instance when it was checked, if its kind prints them. */
                signature?: string[];
                /** What every instance it references looked like when it was evaluated. */
                dependencies: Record<string, { contentHash: string; signature?: string[] }>;
                /** The hash of the scripts and prompts it was evaluated with. */
                evaluatedWith: string;
                result: "pass" | "fail" | "missing" | "orphan";
                errors: string[];
            }
        >,
    ) {}

    /** The manifest at the path, or an empty one when there is none yet. */
    static async load(path: string): Promise<SlytherInstanceManifest> {
        try {
            const read = JSON.parse(await readFile(path, "utf-8"));

            return new SlytherInstanceManifest(path, read.version ?? 1, read.instances ?? {});
        } catch {
            return new SlytherInstanceManifest(path, SlytherInstanceManifest.VERSION, {});
        }
    }

    /** Writes the manifest, with its instances sorted so it diffs well. */
    async save(): Promise<void> {
        const sorted = Object.fromEntries(Object.entries(this.instances).sort(([a], [b]) => a.localeCompare(b)));

        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify({ version: SlytherInstanceManifest.VERSION, instances: sorted }, null, 4)}\n`);
    }
}
