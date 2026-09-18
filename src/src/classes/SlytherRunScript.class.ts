// Imports
import type { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import type { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherParser } from "./SlytherParser.class.ts";

export class SlytherRunScript {
    /** The only configuration a script or a step may declare. */
    private static readonly LANG = "lang";

    constructor(
        /** The `@run` declaration: its content is what the script does. */
        readonly artifact: SlytherArtifact,
        /** Changes whenever the script or any of its steps change. */
        readonly closureHash: string,
        /** Changes whenever the script changes, but not when a step does. */
        readonly scopeHash: string,
        /** The signature the script receives when it runs. */
        readonly params: { name: string; type: string; optional: boolean }[],
        /** The language the script declares, if any. */
        readonly lang: string | undefined,
        /** The steps of the script in the order written, or the script itself as its only step. */
        readonly steps: { artifact: SlytherArtifact; closureHash: string; lang: string }[],
        /** Every artifact the script or its steps reference, for the generator to read. */
        readonly references: SlytherArtifact[],
    ) {}

    /** Groups the scripts declared with `@run` in a parsed script, in the order written. */
    static of(parsed: ParsedSlytherScript): SlytherRunScript[] {
        const artifacts = new Map(parsed.artifacts.map((artifact) => [`${artifact.artifact}:${artifact.name}`, artifact]));
        const scripts = new Map<string, SlytherRunScript>();
        const keyOf = (artifact: SlytherArtifact): string => `${artifact.artifact}:${artifact.name}`;

        for (const artifact of parsed.artifacts) {
            if (artifact.artifact !== SlytherParser.RUN_KIND) {
                continue;
            }

            const params = artifact.args
                .filter((arg) => arg.kind === "type")
                .map((arg) => ({ name: arg.name, type: String(arg.value), optional: arg.optional === true }));

            scripts.set(
                artifact.name,
                new SlytherRunScript(
                    artifact,
                    parsed.closureHashes.get(keyOf(artifact))!,
                    parsed.scopeHashes.get(keyOf(artifact))!,
                    params,
                    SlytherRunScript.configOf(artifact, true),
                    [],
                    [],
                ),
            );
        }

        for (const artifact of parsed.artifacts) {
            const boundary = artifact.name.lastIndexOf("::");
            const script = boundary < 0 ? undefined : scripts.get(artifact.name.slice(0, boundary));

            if (script) {
                script.steps.push({ artifact, closureHash: parsed.closureHashes.get(keyOf(artifact))!, lang: script.langOf(artifact, parsed) });
            }
        }

        for (const script of scripts.values()) {
            if (script.steps.length === 0) {
                const step = script.artifact.as("deterministic", `${script.artifact.name}::${script.name}`);

                script.steps.push({ artifact: step, closureHash: script.closureHash, lang: script.langOf(step, parsed) });
            }

            const referenced = new Set([script.artifact, ...script.steps.map((step) => step.artifact)].flatMap((artifact) => artifact.references));

            script.references.push(...[...referenced].sort().map((key) => artifacts.get(key)).filter((artifact) => artifact !== undefined));
        }

        return [...scripts.values()];
    }

    /** The name of the script, as typed to run it. */
    get name(): string {
        return this.artifact.name.slice(this.artifact.name.lastIndexOf("::") + 2);
    }

    /** The lang of a step: its own, else the script's, else the project's, throwing when none declares one. */
    private langOf(step: SlytherArtifact, parsed: ParsedSlytherScript): string {
        const lang = SlytherRunScript.configOf(step, false) ?? this.lang ?? parsed.lang;

        if (lang === undefined) {
            throw new Error(`Step "${step.name}" has no lang: declare it on the step, on the script, or with @lang on the project.`);
        }

        return lang;
    }

    /** The lang the args declare, which must be the only configuration; only a script may have params besides. */
    private static configOf(artifact: SlytherArtifact, params: boolean): string | undefined {
        let lang: string | undefined;

        for (const arg of artifact.args) {
            if (arg.kind === "type") {
                if (params) {
                    continue;
                }

                throw new Error(`Argument "${arg.name}" of "${artifact.name}" is a type, but a step receives the params of its script.`);
            }

            if (arg.name !== SlytherRunScript.LANG || arg.kind !== "string") {
                throw new Error(`Unknown configuration "${arg.name}" of "${artifact.name}": the only configuration is lang.`);
            }

            lang = String(arg.value);
        }

        return lang;
    }
}
