// Imports
import { ProcessUtils } from "./ProcessUtils.class.ts";
import { SlytherGenerator } from "./SlytherGenerator.class.ts";

export class ClaudeCLIGenerator extends SlytherGenerator {
    /** The executable, overridable so a wrapper or another install can stand in. */
    private static readonly BINARY = process.env.SLYTHER_CLAUDE ?? "claude";
    /** The tools `execute` allows: enough to read, search and edit the project and to run its scripts. */
    private static readonly TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];

    constructor(
        /** The model to ask, SLYTHER_MODEL by default, or the CLI's default when empty. */
        private readonly model = process.env.SLYTHER_MODEL ?? "",
        /**
         * How hard the model thinks, SLYTHER_EFFORT by default, else low: writing a script from its rules
         * needs little, and a high effort keeps the model reasoning for minutes on an ambiguous one.
         */
        private readonly effort = process.env.SLYTHER_EFFORT ?? "low",
    ) {
        super();
    }

    /** The command line of `ask`: print mode, no tools, JSON output shaped by the schema, resuming the session if any. */
    static askCommand(schema: object, session: string | undefined, model: string, effort = ""): string[] {
        return [
            ClaudeCLIGenerator.BINARY,
            "-p",
            "--output-format",
            "json",
            "--json-schema",
            JSON.stringify(schema),
            "--tools",
            "",
            ...(session ? ["--resume", session] : []),
            ...(model ? ["--model", model] : []),
            ...(effort ? ["--effort", effort] : []),
        ];
    }

    /** The command line of `execute`: print mode with the editing tools allowed. */
    static executeCommand(model: string, effort = ""): string[] {
        return [
            ClaudeCLIGenerator.BINARY,
            "-p",
            "--output-format",
            "json",
            "--allowedTools",
            ClaudeCLIGenerator.TOOLS.join(","),
            "--permission-mode",
            "acceptEdits",
            ...(model ? ["--model", model] : []),
            ...(effort ? ["--effort", effort] : []),
        ];
    }

    override async ask<T>(prompt: string, schema: object, session?: string): Promise<{ result: T; session: string }> {
        const reply = await this.call<{ structured_output?: T }>(
            ClaudeCLIGenerator.askCommand(schema, session, this.model, this.effort),
            prompt,
        );

        if (reply.structured_output === undefined) {
            throw new Error(`The Claude CLI did not reply with the structured output asked for:\n${reply.result ?? ""}`);
        }

        return { result: reply.structured_output, session: reply.session_id };
    }

    override async execute(prompt: string, cwd: string): Promise<string> {
        const reply = await this.call(ClaudeCLIGenerator.executeCommand(this.model, this.effort), prompt, cwd);

        return reply.result ?? "";
    }

    /** Runs the CLI with the prompt on stdin, so its length and content never meet the shell, and parses the JSON reply. */
    private async call<T>(
        command: string[],
        prompt: string,
        cwd?: string,
    ): Promise<T & { is_error?: boolean; result?: string; session_id: string }> {
        const { code, stdout, stderr } = await ProcessUtils.run(command, { cwd, stdin: prompt });
        let reply: T & { is_error?: boolean; result?: string; session_id: string };

        try {
            reply = JSON.parse(stdout);
        } catch {
            throw new Error(`The Claude CLI exited with ${code} and no JSON reply.\n${stderr || stdout}`.trim());
        }

        if (reply.is_error) {
            throw new Error(`The Claude CLI could not answer: ${reply.result ?? stderr ?? "no reply"}`);
        }

        return reply;
    }
}
