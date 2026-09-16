// Imports
import type { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";

export class SlytherArtifactKind {
    /** The kinds a step may be. */
    private static readonly STEPS = ["llm", "deterministic"];
    /** The operations that must be verified by an evaluate operation. */
    private static readonly VERIFIED = ["create", "update"];
    /** The only qualifier, and only an operation may have it. */
    private static readonly DETERMINISTIC = "deterministic";

    /** The warnings found while grouping the kind, in the order found. */
    readonly warnings: string[] = [];

    constructor(
        /** The `@artifact` declaration: its content is the rules of the kind. */
        readonly artifact: SlytherArtifact,
        /** Changes whenever the rules or any operation of the kind change. */
        readonly closureHash: string,
        /** The operations of the kind, in the order written. */
        readonly operations: {
            artifact: SlytherArtifact;
            closureHash: string;
            /** Runs as a plain script and never with an llm. */
            deterministic: boolean;
            steps: { artifact: SlytherArtifact; closureHash: string }[];
        }[],
    ) {}

    /** Groups the artifacts of a parsed script into kinds, throwing when the shape of a kind is wrong. */
    static of(parsed: ParsedSlytherScript): SlytherArtifactKind[] {
        const artifacts = new Map(parsed.artifacts.map((artifact) => [artifact.name, artifact]));
        const hashOf = (artifact: SlytherArtifact): string =>
            parsed.closureHashes.get(`${artifact.artifact}:${artifact.name}`)!;
        const kinds = new Map<string, SlytherArtifactKind>();

        for (const artifact of parsed.artifacts) {
            if (artifact.artifact !== "operation") {
                SlytherArtifactKind.checkQualifiers(artifact, []);
            }

            if (artifact.artifact === "artifact") {
                kinds.set(artifact.name, new SlytherArtifactKind(artifact, hashOf(artifact), []));
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
                    closureHash: hashOf(artifact),
                    deterministic: artifact.qualifiers.includes(SlytherArtifactKind.DETERMINISTIC),
                    steps: [],
                });
            }
        }

        for (const artifact of parsed.artifacts) {
            if (SlytherArtifactKind.STEPS.includes(artifact.artifact)) {
                const parent = SlytherArtifactKind.parentOf(artifact.name);
                const operation = kinds
                    .get(SlytherArtifactKind.parentOf(parent))
                    ?.operations.find((candidate) => candidate.artifact.name === parent);

                if (!operation || artifacts.get(parent)?.artifact !== "operation") {
                    throw new Error(`Step "${artifact.name}" must be declared inside an operation.`);
                }

                operation.steps.push({ artifact, closureHash: hashOf(artifact) });
            }
        }

        for (const kind of kinds.values()) {
            kind.check();
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

    private check(): void {
        for (const operation of this.operations) {
            if (operation.deterministic) {
                this.checkDeterministic(operation);
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
    }

    /**
     * A deterministic operation never runs with an llm, so an llm step is an error, and when it has no
     * steps its content is its only step: a deterministic step named after the operation, whose closure
     * hash is the operation's, since that already covers the content.
     */
    private checkDeterministic(operation: SlytherArtifactKind["operations"][number]): void {
        const llm = operation.steps.find((step) => step.artifact.artifact === "llm");

        if (llm) {
            throw new Error(
                `Operation "${operation.artifact.name}" is deterministic but contains the llm step "${llm.artifact.name}".`,
            );
        }

        if (operation.steps.length === 0) {
            const { artifact } = operation;
            const name = artifact.name.slice(artifact.name.lastIndexOf("::") + 2);

            operation.steps.push({
                artifact: new SlytherArtifact(
                    "deterministic",
                    `${artifact.name}::${name}`,
                    [],
                    [],
                    artifact.content,
                    artifact.references,
                ),
                closureHash: operation.closureHash,
            });
        }
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
