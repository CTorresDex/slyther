// Imports
import { ProcessUtils } from "./ProcessUtils.class.ts";
import type { SlytherRuntime } from "./SlytherRuntime.class.ts";

export class SlytherVerifier {
    /** The operations that change nothing when run, so their scripts can be run to check them. */
    private static readonly READ_ONLY = ["locate", "list", "signature", "uses"];
    /** The id an operation is run with when list prints none, and the value every param of an expand is run with. */
    static readonly SAMPLE = "sample";
    /** How long a script gets by default to do what it does before it is killed, with everything it spawned, and counted as a failure. */
    static readonly TIMEOUT = 60_000;
    /** `key shape`: a member of a signature. */
    private static readonly SIGNATURE = /^\S+\s+\S.*$/;
    /** `kind:id key`, `kind:id *` or `kind:id **`: a dependency of an artifact. */
    private static readonly USES = /^[^\s:]+:\S+\s+\S+$/;

    constructor(
        /** The folder the code of the project lives in, where every script runs. */
        private readonly cwd: string,
        /** How long every run of a script is given before it is killed, #{TIMEOUT} unless another is asked for. */
        private readonly timeout: number = SlytherVerifier.TIMEOUT,
    ) {}

    /**
     * Checks the script of a deterministic step and returns why it fails, or null when it passes. The
     * script is checked for syntax, and the scripts of the read-only operations are also run, with the
     * script of list when the step is not list itself, to get a real id to run them with, and with the
     * script of locate when the step is list, since locate must find every id list prints. A read-only
     * operation that takes params after the id is run with a sample value for each of them. The script
     * of an expand is run with the sample args given: it must exit 0 and print what validate accepts.
     * Every run is given #{TIMEOUT} to finish: a script that outruns it is killed, with everything it
     * spawned, and fails, so a script that hangs or spawns without end never passes.
     */
    async verify(step: {
        operation: string;
        script: string;
        runtime: SlytherRuntime;
        /** How many params the operation takes, so the ones after the id are run with a sample value. */
        params?: number;
        list?: { script: string; runtime: SlytherRuntime };
        locate?: { script: string; runtime: SlytherRuntime };
        expand?: { args: string[]; validate: (output: string) => string | null };
    }): Promise<string | null> {
        const check = await ProcessUtils.run(step.runtime.check(step.script), { cwd: this.cwd, timeout: this.timeout });

        if (check.code !== 0) {
            return `${step.script} does not pass the syntax check:\n${check.stderr || check.stdout}`;
        }

        if (step.expand) {
            const run = await ProcessUtils.run([...step.runtime.run(step.script), ...step.expand.args], { cwd: this.cwd, timeout: this.timeout });
            const timeout = this.timedOut(step.script, run);

            if (timeout) {
                return timeout;
            }

            if (run.code !== 0) {
                return `${step.script} must exit 0 given ${step.expand.args.map((arg) => `"${arg}"`).join(" ")} but exited ${run.code}:\n${run.stderr}`;
            }

            const problem = step.expand.validate(run.stdout);

            return problem === null ? null : `${step.script} printed declarations that are not accepted:\n${problem}`;
        }

        if (!SlytherVerifier.READ_ONLY.includes(step.operation)) {
            return null;
        }

        if (step.operation === "list") {
            const list = await ProcessUtils.run(step.runtime.run(step.script), { cwd: this.cwd, timeout: this.timeout });
            const timeout = this.timedOut(step.script, list);

            if (timeout) {
                return timeout;
            }

            if (list.code !== 0) {
                return `${step.script} must exit 0 but exited ${list.code}:\n${list.stderr}`;
            }

            const [id] = SlytherVerifier.linesOf(list.stdout);

            if (id === undefined || !step.locate) {
                return null;
            }

            const located = await ProcessUtils.run([...step.locate.runtime.run(step.locate.script), id], { cwd: this.cwd, timeout: this.timeout });

            return located.code === 0
                ? null
                : `${step.script} printed the id "${id}" but ${step.locate.script} does not find it: list must print the ids locate takes.`;
        }

        const id = (await this.firstId(step.list)) ?? SlytherVerifier.SAMPLE;
        const args = [id, ...SlytherVerifier.samples(step.params)];
        const run = await ProcessUtils.run([...step.runtime.run(step.script), ...args], { cwd: this.cwd, timeout: this.timeout });
        const timeout = this.timedOut(step.script, run);

        if (timeout) {
            return timeout;
        }

        if (run.code !== 0 && run.code !== 1) {
            return `${step.script} must exit 0 or 1 given ${args.map((arg) => `"${arg}"`).join(" ")} but exited ${run.code}:\n${run.stderr}`;
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

    /** Why a script that outran the timeout failed, or null when it did not: a script that hangs, or that spawns without end, never passes. */
    private timedOut(script: string, run: { code: number }): string | null {
        return run.code === ProcessUtils.TIMED_OUT
            ? `${script} did not finish in ${this.timeout}ms and was killed, with everything it spawned: it must do its work and exit, and it must never run a script that runs it back.`
            : null;
    }

    /** A sample value for every param of the operation after the id. */
    private static samples(params: number | undefined): string[] {
        return Array.from({ length: Math.max((params ?? 1) - 1, 0) }, () => SlytherVerifier.SAMPLE);
    }

    private async firstId(list: { script: string; runtime: SlytherRuntime } | undefined): Promise<string | undefined> {
        if (!list) {
            return undefined;
        }

        const run = await ProcessUtils.run(list.runtime.run(list.script), { cwd: this.cwd, timeout: this.timeout });

        return run.code === 0 ? SlytherVerifier.linesOf(run.stdout)[0] : undefined;
    }

    private static linesOf(output: string): string[] {
        return output.split("\n").filter((line) => line.trim().length > 0);
    }
}
