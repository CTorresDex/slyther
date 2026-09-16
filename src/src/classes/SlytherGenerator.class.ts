// Imports

export abstract class SlytherGenerator {
    /** What a reply to `generate` and `fix` must look like. */
    private static readonly SCHEMA = {
        type: "object",
        properties: {
            files: {
                type: "array",
                items: {
                    type: "object",
                    properties: { path: { type: "string" }, content: { type: "string" } },
                    required: ["path", "content"],
                },
            },
            dependencies: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["files", "dependencies"],
    };

    /**
     * Sends the prompt and returns a reply that matches the schema, along with the session a later
     * call may resume so the conversation continues.
     */
    abstract ask<T>(prompt: string, schema: object, session?: string): Promise<{ result: T; session: string }>;

    /** Runs the prompt with the tools to read and edit the project in the given directory, returning the reply. */
    abstract execute(prompt: string, cwd: string): Promise<string>;

    /** Writes the files a task asks for. */
    async generate(task: {
        instructions: string;
        context: { path: string; content: string }[];
        expected: string[];
        dependencies: Record<string, string>;
    }): Promise<{ files: { path: string; content: string }[]; dependencies: Record<string, string>; session: string }> {
        const prompt = [
            task.instructions,
            "",
            "## Dependencies already installed",
            "",
            Object.keys(task.dependencies).length === 0
                ? "None. Declare in `dependencies` every package a file imports, as `name: version`, and prefer needing none."
                : `Reuse these instead of adding another package or version for the same purpose:\n${Object.entries(task.dependencies)
                      .map(([name, version]) => `- ${name}: ${version}`)
                      .join("\n")}\n\nDeclare in \`dependencies\` every package a file imports, as \`name: version\`.`,
            "",
            "## Context",
            "",
            task.context.length === 0
                ? "None."
                : task.context.map((file) => `### ${file.path}\n\n\`\`\`\n${file.content}\n\`\`\``).join("\n\n"),
            "",
            "## Reply",
            "",
            `Reply with exactly these files in \`files\`, each with its full content: ${task.expected.map((path) => `\`${path}\``).join(", ")}.`,
        ].join("\n");

        return this.reply(prompt, task.expected);
    }

    /** Resumes the session with why the files failed and returns them corrected. */
    async fix(
        session: string,
        failure: string,
        expected: string[],
    ): Promise<{ files: { path: string; content: string }[]; dependencies: Record<string, string>; session: string }> {
        const prompt = [
            "The files you wrote failed verification:",
            "",
            "```",
            failure.trim(),
            "```",
            "",
            `Fix them and reply again with exactly these files in \`files\`, each with its full content: ${expected.map((path) => `\`${path}\``).join(", ")}.`,
        ].join("\n");

        return this.reply(prompt, expected, session);
    }

    private async reply(
        prompt: string,
        expected: string[],
        session?: string,
    ): Promise<{ files: { path: string; content: string }[]; dependencies: Record<string, string>; session: string }> {
        const reply = await this.ask<{ files: { path: string; content: string }[]; dependencies: Record<string, string> }>(
            prompt,
            SlytherGenerator.SCHEMA,
            session,
        );
        const paths = reply.result.files.map((file) => file.path);
        const missing = expected.filter((path) => !paths.includes(path));
        const unexpected = paths.filter((path) => !expected.includes(path));

        if (missing.length > 0 || unexpected.length > 0) {
            throw new Error(
                `The generator replied with the wrong files: ${[
                    ...missing.map((path) => `"${path}" is missing`),
                    ...unexpected.map((path) => `"${path}" was not asked for`),
                ].join(", ")}.`,
            );
        }

        return { files: reply.result.files, dependencies: reply.result.dependencies ?? {}, session: reply.session };
    }
}
