// Imports
import type { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import type { SlytherArtifact } from "./SlytherArtifact.class.ts";

export class SlytherArtifactKind {
    /** The kinds a step may be. */
    private static readonly STEPS = ["llm", "deterministic"];
    /** The operations that must be verified by an evaluate operation. */
    private static readonly VERIFIED = ["create", "update"];

    constructor(
        /** The `@artifact` declaration: its content is the rules of the kind. */
        readonly artifact: SlytherArtifact,
        /** Changes whenever the rules or any operation of the kind change. */
        readonly closureHash: string,
        /** The operations of the kind, in the order written. */
        readonly operations: {
            artifact: SlytherArtifact;
            closureHash: string;
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

                kind.operations.push({ artifact, closureHash: hashOf(artifact), steps: [] });
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
            if (operation.steps.length === 0) {
                throw new Error(`Operation "${operation.artifact.name}" has no steps.`);
            }
        }

        const unverified = SlytherArtifactKind.VERIFIED.filter((name) => this.operation(name));

        if (unverified.length > 0 && !this.operation("evaluate")) {
            throw new Error(
                `Kind "${this.name}" defines ${unverified.join(" and ")} but no evaluate operation to verify ${unverified.length > 1 ? "them" : "it"} with.`,
            );
        }
    }

    private static parentOf(name: string): string {
        const boundary = name.lastIndexOf("::");

        return boundary < 0 ? "" : name.slice(0, boundary);
    }
}
