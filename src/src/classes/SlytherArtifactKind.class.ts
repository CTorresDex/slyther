// Imports
import type { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherBuiltinOperation } from "./SlytherBuiltinOperation.class.ts";
import { SlytherParser } from "./SlytherParser.class.ts";

export class SlytherArtifactKind {
    /** The kinds a step may be. */
    private static readonly STEPS = ["llm", "deterministic"];
    /** The operations that must be verified by an evaluate operation. */
    private static readonly VERIFIED = ["create", "update"];
    /** The only qualifier, and only an operation may have it. */
    private static readonly DETERMINISTIC = "deterministic";
    /** The only configuration a kind or a step may declare. */
    private static readonly LANG = "lang";

    /** The warnings found while grouping the kind, in the order found. */
    readonly warnings: string[] = [];

    constructor(
        /** The `@artifact` declaration: its content is the rules of the kind. */
        readonly artifact: SlytherArtifact,
        /** Changes whenever the rules or any operation of the kind change. */
        readonly closureHash: string,
        /** Changes whenever the rules change, but not when an operation does. */
        readonly scopeHash: string,
        /** The language the kind declares, if any. */
        readonly lang: string | undefined,
        /** The operations of the kind, in the order written, then the built-in ones. */
        readonly operations: {
            artifact: SlytherArtifact;
            closureHash: string;
            scopeHash: string;
            /** The signature the operation receives when it runs. */
            params: { name: string; type: string; optional: boolean }[];
            /** Runs as a plain script and never with an llm. */
            deterministic: boolean;
            /** Added by Slyther, not written in the script. */
            builtin: boolean;
            steps: { artifact: SlytherArtifact; closureHash: string; lang?: string }[];
        }[],
    ) {}

    /** Groups the artifacts of a parsed script into kinds, throwing when the shape of a kind is wrong. */
    static of(parsed: ParsedSlytherScript): SlytherArtifactKind[] {
        const artifacts = new Map(parsed.artifacts.map((artifact) => [artifact.name, artifact]));
        const keyOf = (artifact: SlytherArtifact): string => `${artifact.artifact}:${artifact.name}`;
        const kinds = new Map<string, SlytherArtifactKind>();

        for (const artifact of parsed.artifacts) {
            if (artifact.artifact !== "operation") {
                SlytherArtifactKind.checkQualifiers(artifact, []);
            }

            if (artifact.artifact === "artifact") {
                kinds.set(
                    artifact.name,
                    new SlytherArtifactKind(
                        artifact,
                        parsed.closureHashes.get(keyOf(artifact))!,
                        parsed.scopeHashes.get(keyOf(artifact))!,
                        SlytherArtifactKind.configOf(artifact),
                        [],
                    ),
                );
            }
        }

        for (const artifact of parsed.artifacts) {
            if (artifact.artifact === "operation") {
                const kind = kinds.get(SlytherArtifactKind.parentOf(artifact.name));

                if (!kind) {
                    throw new Error(`Operation "${artifact.name}" must be declared inside a kind.`);
                }

                SlytherArtifactKind.checkQualifiers(artifact, [SlytherArtifactKind.DETERMINISTIC]);

                kind.operations.push({
                    artifact,
                    closureHash: parsed.closureHashes.get(keyOf(artifact))!,
                    scopeHash: parsed.scopeHashes.get(keyOf(artifact))!,
                    params: SlytherArtifactKind.paramsOf(artifact),
                    deterministic: artifact.qualifiers.includes(SlytherArtifactKind.DETERMINISTIC),
                    builtin: false,
                    steps: [],
                });
            }
        }

        for (const artifact of parsed.artifacts) {
            if (SlytherArtifactKind.STEPS.includes(artifact.artifact)) {
                const parent = SlytherArtifactKind.parentOf(artifact.name);
                const kind = kinds.get(SlytherArtifactKind.parentOf(parent));
                const operation = kind?.operations.find((candidate) => candidate.artifact.name === parent);

                if (!kind || !operation || artifacts.get(parent)?.artifact !== "operation") {
                    throw new Error(`Step "${artifact.name}" must be declared inside an operation.`);
                }

                operation.steps.push({
                    artifact,
                    closureHash: parsed.closureHashes.get(keyOf(artifact))!,
                    ...kind.langOf(artifact, parsed),
                });
            }
        }

        for (const kind of kinds.values()) {
            kind.check(parsed);
            kind.addBuiltins(parsed);
        }

        return [...kinds.values()];
    }

    /** The name of the kind. */
    get name(): string {
        return this.artifact.name;
    }

    /** The rules every artifact of the kind must follow. */
    get rules(): string {
        return this.artifact.content;
    }

    /** The operation of the given name, if the kind defines it. */
    operation(name: string): SlytherArtifactKind["operations"][number] | undefined {
        return this.operations.find((operation) => operation.artifact.name === `${this.name}::${name}`);
    }

    private check(parsed: ParsedSlytherScript): void {
        for (const operation of this.operations) {
            if (operation.deterministic) {
                this.checkDeterministic(operation, parsed);
            } else if (operation.steps.length === 0) {
                throw new Error(`Operation "${operation.artifact.name}" has no steps.`);
            } else if (operation.steps.every((step) => step.artifact.artifact === "deterministic")) {
                this.warnings.push(
                    `Operation "${operation.artifact.name}" has only deterministic steps: qualify it as deterministic.`,
                );
            }
        }

        const unverified = SlytherArtifactKind.VERIFIED.filter((name) => this.operation(name));

        if (unverified.length > 0 && !this.operation("evaluate")) {
            throw new Error(
                `Kind "${this.name}" defines ${unverified.join(" and ")} but no evaluate operation to verify ${unverified.length > 1 ? "them" : "it"} with.`,
            );
        }

        const locate = this.operation("locate");

        if (this.operations.length > 0 && !locate) {
            throw new Error(`Kind "${this.name}" defines operations but no locate operation to find its artifacts with.`);
        }

        if (locate && !locate.deterministic) {
            throw new Error(`Operation "${locate.artifact.name}" must be deterministic.`);
        }

        if (locate && !SlytherArtifactKind.isIdSignature(locate.params)) {
            throw new Error(`Operation "${locate.artifact.name}" must have the params (id: string).`);
        }
    }

    /**
     * A deterministic operation never runs with an llm, so an llm step is an error, and when it has no
     * steps its content is its only step: a deterministic step named after the operation, whose closure
     * hash is the operation's, since that already covers the content.
     */
    private checkDeterministic(operation: SlytherArtifactKind["operations"][number], parsed: ParsedSlytherScript): void {
        const llm = operation.steps.find((step) => step.artifact.artifact === "llm");

        if (llm) {
            throw new Error(
                `Operation "${operation.artifact.name}" is deterministic but contains the llm step "${llm.artifact.name}".`,
            );
        }

        if (operation.steps.length === 0) {
            const { artifact } = operation;
            const name = artifact.name.slice(artifact.name.lastIndexOf("::") + 2);
            const step = new SlytherArtifact(
                "deterministic",
                `${artifact.name}::${name}`,
                [],
                [],
                artifact.content,
                artifact.references,
            );

            operation.steps.push({ artifact: step, closureHash: operation.closureHash, ...this.langOf(step, parsed) });
        }
    }

    /**
     * Adds every built-in operation the kind does not declare, once it is known to have operations. The
     * ones that serve the artifacts referencing an instance of the kind are only added when there is one.
     */
    private addBuiltins(parsed: ParsedSlytherScript): void {
        if (this.operations.length === 0) {
            return;
        }

        const referenced = parsed.artifacts.some((artifact) =>
            artifact.references.some((reference) => reference.startsWith(`${this.name}:`) && reference !== `${artifact.artifact}:${artifact.name}`),
        );

        for (const artifact of SlytherBuiltinOperation.of(this.name, referenced)) {
            if (this.operations.some((operation) => operation.artifact.name === artifact.name)) {
                continue;
            }

            const operation: SlytherArtifactKind["operations"][number] = {
                artifact,
                closureHash: artifact.hash,
                scopeHash: artifact.hash,
                params: SlytherArtifactKind.paramsOf(artifact),
                deterministic: true,
                builtin: true,
                steps: [],
            };

            this.operations.push(operation);
            this.checkDeterministic(operation, parsed);
        }
    }

    /**
     * The lang of a step: its own, else the kind's, else the script's. Only a deterministic step has
     * one, and one that has none to inherit throws. An llm step declaring one throws too.
     */
    private langOf(step: SlytherArtifact, parsed: ParsedSlytherScript): { lang?: string } {
        const own = SlytherArtifactKind.configOf(step);

        if (step.artifact === "llm") {
            if (own !== undefined) {
                throw new Error(`Step "${step.name}" is an llm step and cannot declare a lang.`);
            }

            return {};
        }

        const lang = own ?? this.lang ?? parsed.lang;

        if (lang === undefined) {
            throw new Error(
                `Step "${step.name}" has no lang: declare it on the step, on the kind, or with @lang on the project.`,
            );
        }

        return { lang };
    }

    /** The lang a kind or a step declares in its args, which must be its only configuration. */
    private static configOf(artifact: SlytherArtifact): string | undefined {
        let lang: string | undefined;

        for (const arg of artifact.args) {
            if (arg.kind === "type") {
                throw new Error(`Argument "${arg.name}" of "${artifact.name}" is a type, but only an operation has params.`);
            }

            if (arg.name !== SlytherArtifactKind.LANG || arg.kind !== "string") {
                throw new Error(`Unknown configuration "${arg.name}" of "${artifact.name}": the only configuration is lang.`);
            }

            lang = String(arg.value);
        }

        return lang;
    }

    /** The params of an operation, which must all be types. */
    private static paramsOf(artifact: SlytherArtifact): SlytherArtifactKind["operations"][number]["params"] {
        return artifact.args.map((arg) => {
            if (arg.kind !== "type") {
                throw new Error(`Argument "${arg.name}" of "${artifact.name}" must be a type: the args of an operation are its params.`);
            }

            return { name: arg.name, type: String(arg.value), optional: arg.optional === true };
        });
    }

    private static isIdSignature(params: SlytherArtifactKind["operations"][number]["params"]): boolean {
        return params.length === 1 && params[0]!.name === "id" && params[0]!.type === "string" && !params[0]!.optional;
    }

    private static checkQualifiers(artifact: SlytherArtifact, allowed: string[]): void {
        const unknown = artifact.qualifiers.find((qualifier) => !allowed.includes(qualifier));

        if (unknown) {
            throw new Error(
                allowed.length === 0
                    ? `"${artifact.name}" cannot be qualified: only an operation may be, as deterministic.`
                    : `Unknown qualifier "${unknown}" of "${artifact.name}": the only qualifier is deterministic.`,
            );
        }
    }

    private static parentOf(name: string): string {
        const boundary = name.lastIndexOf("::");

        return boundary < 0 ? "" : name.slice(0, boundary);
    }
}
