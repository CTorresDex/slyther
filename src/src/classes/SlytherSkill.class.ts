// Imports
import type { SlytherArtifactKind } from "./SlytherArtifactKind.class.ts";

export class SlytherSkill {
    /** The operations whose skill ends with the evaluation loop. */
    private static readonly VERIFIED = ["create", "update"];

    constructor(
        readonly kind: SlytherArtifactKind,
        readonly operation: SlytherArtifactKind["operations"][number],
        /** One sentence on what the operation does, for the skill's frontmatter. */
        private readonly description: string,
        /** How to run each deterministic step, keyed by the step's name, with the script path already in place. */
        private readonly instructions: Map<string, string>,
    ) {}

    /** The name the skill is invoked by. */
    get name(): string {
        return `${this.short(this.operation)}-${this.kind.name}`;
    }

    /** The SKILL.md text. */
    render(): string {
        const sections = [
            `---\nname: ${this.name}\ndescription: ${JSON.stringify(this.description)}\n---`,
            `# ${this.short(this.operation)} ${this.kind.name}`,
            "Every step below is either **deterministic** (run the script exactly as written, from the project root,\n" +
                "and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.\n" +
                "Follow the steps in order.",
            `## Rules\n\n${this.kind.rules}`,
            `## Steps\n\n${this.steps(this.operation).join("\n\n")}`,
        ];
        const evaluate = this.kind.operation("evaluate");

        if (evaluate && SlytherSkill.VERIFIED.includes(this.short(this.operation))) {
            const steps = this.steps(evaluate);

            steps.push(
                `${steps.length + 1}. **llm** — If every deterministic step of this loop exited 0, the loop is done.\n` +
                    "   Otherwise fix every discrepancy they reported, editing the files as located by the rules,\n" +
                    "   and restart the loop from its first step. Repeat until every deterministic step exits 0.",
            );
            sections.push(
                `## Evaluation loop\n\nAfter the steps above, the ${this.kind.name} must comply with the rules. Verify it with this loop:\n\n${steps.join("\n\n")}`,
            );
        }

        return `${sections.join("\n\n")}\n`;
    }

    /** The numbered steps of an operation, an llm step by its prose and a deterministic one by its instruction. */
    private steps(operation: SlytherArtifactKind["operations"][number]): string[] {
        return operation.steps.map((step, index) => {
            const text =
                step.artifact.artifact === "deterministic"
                    ? this.instructions.get(step.artifact.name) ?? step.artifact.content
                    : step.artifact.content;

            return `${index + 1}. **${step.artifact.artifact}** — ${text.replace(/\n/g, "\n   ")}`;
        });
    }

    /** The operation's own name, without the kind it belongs to. */
    private short(operation: SlytherArtifactKind["operations"][number]): string {
        return operation.artifact.name.slice(operation.artifact.name.lastIndexOf("::") + 2);
    }
}
