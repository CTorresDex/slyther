// Imports

export class ClaudeCLI {
    /** The executable, overridable so a wrapper or another install can stand in. */
    private static readonly BINARY = process.env.SLYTHER_CLAUDE ?? "claude";

    constructor(
        /** The model to ask, or the CLI's default when empty. */
        private readonly model = "",
    ) {}

    /**
     * Asks the CLI the prompt in print mode with every tool disabled and returns the text of the
     * reply. The prompt is handed over stdin so its length and content never meet the shell.
     */
    async ask(prompt: string): Promise<string> {
        const command = [
            ClaudeCLI.BINARY,
            "-p",
            "--no-session-persistence",
            "--output-format",
            "json",
            "--tools",
            "",
            ...(this.model ? ["--model", this.model] : []),
        ];
        const process = Bun.spawn(command, { stdin: Buffer.from(prompt), stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.exited,
        ]);

        let reply: { is_error?: boolean; result?: string };

        try {
            reply = JSON.parse(stdout);
        } catch {
            throw new Error(`The Claude CLI exited with ${code} and no JSON reply.\n${stderr || stdout}`.trim());
        }

        if (reply.is_error || typeof reply.result !== "string") {
            throw new Error(`The Claude CLI could not answer: ${reply.result ?? stderr ?? "no reply"}`);
        }

        return reply.result;
    }

    /** Asks for a JSON object and parses it, tolerating a reply wrapped in a code fence. */
    async askJSON<T>(prompt: string): Promise<T> {
        const reply = await this.ask(prompt);
        const opening = reply.indexOf("{");
        const closing = reply.lastIndexOf("}");

        if (opening < 0 || closing < opening) {
            throw new Error(`The Claude CLI did not reply with a JSON object:\n${reply}`);
        }

        try {
            return JSON.parse(reply.slice(opening, closing + 1)) as T;
        } catch {
            throw new Error(`The Claude CLI replied with malformed JSON:\n${reply}`);
        }
    }
}
