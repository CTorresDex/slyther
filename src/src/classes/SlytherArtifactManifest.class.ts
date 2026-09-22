// Imports
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SlytherArtifactManifest {
    /** The name of the manifest inside the artifacts folder. */
    static readonly FILE = "manifest.json";

    private constructor(
        /** Where the manifest is written. */
        private readonly path: string,
        /** Every operation built, keyed by `kind::name`: what running it needs to know. */
        readonly operations: Record<
            string,
            {
                kind: string;
                name: string;
                deterministic: boolean;
                params: { name: string; type: string; optional: boolean }[];
                /** The markdown that orchestrates the steps, for an operation that is not deterministic. */
                entry?: string;
                /** The role that runs that markdown. */
                role?: string;
                /** Every step, with the role its work is done by: who wrote its script, or who does what its llm step says. */
                steps: { name: string; kind: "llm" | "deterministic"; path: string; lang?: string; run?: string[]; role?: string }[];
            }
        >,
        /** Every script that runs the project, keyed by its name: what running it needs to know. */
        readonly scripts: Record<
            string,
            {
                name: string;
                params: { name: string; type: string; optional: boolean }[];
                steps: { name: string; path: string; lang: string; run: string[] }[];
            }
        >,
        /** Every file built, keyed by its path relative to the artifacts folder: what deciding to rebuild it needs. */
        readonly files: Record<string, { inputHash: string; outputHash: string; dependencies?: Record<string, string>; writtenBy?: string }>,
    ) {}

    /** The manifest at the path, or an empty one when there is none yet. */
    static async load(path: string): Promise<SlytherArtifactManifest> {
        try {
            const parsed = JSON.parse(await readFile(path, "utf-8"));

            return new SlytherArtifactManifest(path, parsed.operations ?? {}, parsed.scripts ?? {}, parsed.files ?? {});
        } catch {
            return new SlytherArtifactManifest(path, {}, {}, {});
        }
    }

    /** The hash a file is recorded with, so a later build knows whether it was edited by hand. */
    static hashOf(content: string): string {
        return createHash("sha256").update(content).digest("hex");
    }

    /** Writes the manifest, with its entries sorted so it diffs well. */
    async save(): Promise<void> {
        const sorted = <T>(record: Record<string, T>): Record<string, T> =>
            Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(
            this.path,
            `${JSON.stringify({ operations: sorted(this.operations), scripts: sorted(this.scripts), files: sorted(this.files) }, null, 4)}\n`,
        );
    }

    /** The union of the dependencies every file of the lang declares, one version per package. */
    dependenciesOf(lang: string): Record<string, string> {
        const union: Record<string, string> = {};

        for (const [path, file] of Object.entries(this.files)) {
            const step = [...Object.values(this.operations), ...Object.values(this.scripts)]
                .flatMap((owner): { path: string; lang?: string }[] => owner.steps)
                .find((step) => step.path === path);

            if (step?.lang !== lang) {
                continue;
            }

            for (const [name, version] of Object.entries(file.dependencies ?? {})) {
                union[name] = version;
            }
        }

        return union;
    }
}
