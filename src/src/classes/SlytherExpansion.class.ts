// Imports
import type { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import type { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherArtifactKind } from "./SlytherArtifactKind.class.ts";
import { SlytherParser } from "./SlytherParser.class.ts";

export class SlytherExpansion {
    /** The params of create an emitted declaration never has to give. */
    private static readonly FILLED = ["id", "errors"];

    /**
     * Reads what the expand of a composite kind printed for an instance into the script that declares
     * it: the declarations the instance is made of, named relative to it and referencing it. Returns
     * the script with them added and the `kind:name` of every one emitted, and throws, naming the
     * instance, when the text does not parse, holds anything but a declaration of an artifact, emits a
     * kind the expand does not reference, or a composite one, or one that cannot be created, or gives
     * nothing for a param its create needs.
     */
    static of(
        text: string,
        instance: SlytherArtifact,
        kinds: SlytherArtifactKind[],
        parsed: ParsedSlytherScript,
    ): { parsed: ParsedSlytherScript; emitted: string[] } {
        const key = `${instance.artifact}:${instance.name}`;
        const kind = kinds.find((candidate) => candidate.name === instance.artifact);

        if (!kind?.composite) {
            throw new Error(`${key} is not an instance of a composite kind.`);
        }

        let extended: ReturnType<SlytherParser["extend"]>;

        try {
            extended = new SlytherParser().extend(parsed, instance, text);
        } catch (error) {
            throw new Error(`${key} emitted something that cannot be read: ${error instanceof Error ? error.message : String(error)}`);
        }

        for (const artifact of extended.added) {
            SlytherExpansion.check(key, kind, kinds, artifact);
        }

        return { parsed: extended.parsed, emitted: extended.added.map((artifact) => `${artifact.artifact}:${artifact.name}`) };
    }

    private static check(key: string, parent: SlytherArtifactKind, kinds: SlytherArtifactKind[], artifact: SlytherArtifact): void {
        const what = `${key} emitted the ${artifact.artifact} "${artifact.name}"`;

        if (SlytherParser.BUILTIN.includes(artifact.artifact) || artifact.artifact === SlytherParser.RUN_KIND) {
            throw new Error(`${what}, but it may only emit artifacts.`);
        }

        if (!parent.emits.includes(artifact.artifact)) {
            throw new Error(
                `${what}, but its expand does not reference ${artifact.artifact}: it may only emit ${parent.emits.length > 0 ? parent.emits.join(", ") : "nothing, since it references no kind"}.`,
            );
        }

        const kind = kinds.find((candidate) => candidate.name === artifact.artifact)!;

        if (kind.composite) {
            throw new Error(`${what}, but ${kind.name} is composite: a composite kind cannot emit another.`);
        }

        for (const arg of artifact.args) {
            if (!kind.params.some((param) => param.name === arg.name)) {
                throw new Error(
                    `${what} with the arg "${arg.name}", which ${kind.name} does not declare: it takes ${
                        kind.params.length > 0 ? kind.params.map((param) => param.name).join(", ") : "no args"
                    }.`,
                );
            }
        }

        const create = kind.operation("create");

        if (!create) {
            throw new Error(`${what}, but a ${kind.name} cannot be created: it has no create operation.`);
        }

        for (const param of create.params) {
            if (SlytherExpansion.FILLED.includes(param.name) || param.optional) {
                continue;
            }

            const arg = artifact.args.find((candidate) => candidate.name === param.name);
            const value = arg !== undefined ? String(arg.value) : artifact.content;

            if (value === "") {
                throw new Error(`${what} without "${param.name}", which its create needs: give it as an arg or as its prose.`);
            }
        }
    }
}
