// Imports
import { ProcessUtils } from "./ProcessUtils.class.ts";
import type { SlytherRuntime } from "./SlytherRuntime.class.ts";

export class SlytherVerifier {
    /** The operations that change nothing when run, so their scripts can be run to check them. */
    private static readonly READ_ONLY = ["locate", "list", "signature", "uses"];
    /** The id an operation is run with when list prints none. */
    private static readonly SAMPLE = "sample";
    /** `key shape`: a member of a signature. */
    private static readonly SIGNATURE = /^\S+\s+\S.*$/;
    /** `kind:id key`, `kind:id *` or `kind:id **`: a dependency of an artifact. */
    private static readonly USES = /^[^\s:]+:\S+\s+\S+$/;

    constructor(
        /** The root of the project, where every script runs. */
        private readonly root: string,
    ) {}

    /**
     * Checks the script of a deterministic step and returns why it fails, or null when it passes. The
     * script is checked for syntax, and the scripts of the read-only operations are also run, with the
     * script of list when the step is not list itself, to get a real id to run them with.
     */
    async verify(step: {
        operation: string;
        script: string;
        runtime: SlytherRuntime;
        list?: { script: string; runtime: SlytherRuntime };
    }): Promise<string | null> {
        const check = await ProcessUtils.run(step.runtime.check(step.script), { cwd: this.root });

        if (check.code !== 0) {
            return `${step.script} does not pass the syntax check:\n${check.stderr || check.stdout}`;
        }

        if (!SlytherVerifier.READ_ONLY.includes(step.operation)) {
            return null;
        }

        if (step.operation === "list") {
            const list = await ProcessUtils.run(step.runtime.run(step.script), { cwd: this.root });

            return list.code === 0 ? null : `${step.script} must exit 0 but exited ${list.code}:\n${list.stderr}`;
        }

        const id = (await this.firstId(step.list)) ?? SlytherVerifier.SAMPLE;
        const run = await ProcessUtils.run([...step.runtime.run(step.script), id], { cwd: this.root });

        if (run.code !== 0 && run.code !== 1) {
            return `${step.script} must exit 0 or 1 given "${id}" but exited ${run.code}:\n${run.stderr}`;
        }

        if (run.code === 1 && run.stdout.trim()) {
            return `${step.script} must print nothing when it exits 1, but given "${id}" it printed:\n${run.stdout}`;
        }

        const pattern =
            step.operation === "signature" ? SlytherVerifier.SIGNATURE : step.operation === "uses" ? SlytherVerifier.USES : null;
        const invalid = pattern && run.code === 0 ? SlytherVerifier.linesOf(run.stdout).find((line) => !pattern.test(line)) : undefined;

        if (invalid !== undefined) {
            return `${step.script} printed a line that is not \`${step.operation === "signature" ? "key shape" : "kind:id key"}\` given "${id}":\n${invalid}`;
        }

        return null;
    }

    private async firstId(list: { script: string; runtime: SlytherRuntime } | undefined): Promise<string | undefined> {
        if (!list) {
            return undefined;
        }

        const run = await ProcessUtils.run(list.runtime.run(list.script), { cwd: this.root });

        return run.code === 0 ? SlytherVerifier.linesOf(run.stdout)[0] : undefined;
    }

    private static linesOf(output: string): string[] {
        return output.split("\n").filter((line) => line.trim().length > 0);
    }
}
