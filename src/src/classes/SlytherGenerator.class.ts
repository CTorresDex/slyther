// Imports
import type { SlytherRole } from "./SlytherRole.class.ts";

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
    /** What a reply to `review` must look like. */
    private static readonly VERDICT = {
        type: "object",
        properties: {
            pass: { type: "boolean" },
            errors: { type: "array", items: { type: "string" } },
        },
        required: ["pass", "errors"],
    };

    /**
     * Sends the prompt and returns a reply that matches the schema, along with the session a later
     * call may resume so the conversation continues. The cast says which role the work is for and who
     * plays it, which is who is asked.
     */
    abstract ask<T>(prompt: string, schema: object, session?: string, cast?: SlytherRole["cast"]): Promise<{ result: T; session: string }>;

    /**
     * Runs the prompt with the tools to read and edit the project in the given directory, resuming the
     * session when given one, and returns the text of the reply along with the session a later call may
     * resume so a fix continues the conversation that wrote the code. The cast is who is asked, as for ask.
     */
    abstract execute(prompt: string, cwd: string, session?: string, cast?: SlytherRole["cast"]): Promise<{ text: string; session: string }>;

    /**
     * What keeps the generator from asking for the work of these casts, one line per problem, before any
     * of it is asked for: a role nobody plays, a provider it does not know, an option it cannot take.
     * Nothing, unless a generator knows better.
     */
    problemsWith(_casts: SlytherRole["cast"][]): string[] {
        return [];
    }

    /**
     * The options a role is played with, with whatever the provider would resolve differently from one run
     * to the next, like a model named by an alias, pinned to what it resolves to now: every call of a build
     * then asks the same way, and what is recorded names what was asked. The options as they are, unless a
     * generator knows better.
     */
    async pin(options: Record<string, string>): Promise<Record<string, string>> {
        return options;
    }

    /**
     * Who plays every role, pinned as #{pin} does, asking each provider for each set of options once. Only
     * the roles named are pinned, since a role nobody's work asks for needs nothing resolved. Every role as
     * it is, unless a generator knows better.
     */
    async pinRoles(roles: Map<string, SlytherRole["binding"]>, _named: string[]): Promise<Map<string, SlytherRole["binding"]>> {
        return roles;
    }

    /** Writes the files a task asks for, asking whoever plays the role of the cast. */
    async generate(task: {
        instructions: string;
        context: { path: string; content: string }[];
        expected: string[];
        dependencies: Record<string, string>;
        cast?: SlytherRole["cast"];
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

        return this.reply(prompt, task.expected, undefined, task.cast);
    }

    /** Resumes the session with why the files failed and returns them corrected. */
    async fix(
        session: string,
        failure: string,
        expected: string[],
        cast?: SlytherRole["cast"],
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

        return this.reply(prompt, expected, session, cast);
    }

    /**
     * Asks, in a session of its own so whoever wrote the files never approves them, whether they do what the
     * instructions say, reading them without running them.
     */
    async review(instructions: string, files: { path: string; content: string }[], cast?: SlytherRole["cast"]): Promise<{ pass: boolean; errors: string[] }> {
        const prompt = [
            "Review whether these files do what the instructions they were written from say. Read them, do not run them.",
            "Fail them only for what they do wrong or leave out, not for style, and name every error so it can be fixed.",
            "",
            "## Instructions",
            "",
            instructions,
            "",
            "## Files",
            "",
            files.map((file) => `### ${file.path}\n\n\`\`\`\n${file.content}\n\`\`\``).join("\n\n"),
        ].join("\n");
        const reply = await this.ask<{ pass: boolean; errors: string[] }>(prompt, SlytherGenerator.VERDICT, undefined, cast);

        return { pass: reply.result.pass === true, errors: reply.result.errors ?? [] };
    }

    private async reply(
        prompt: string,
        expected: string[],
        session?: string,
        cast?: SlytherRole["cast"],
    ): Promise<{ files: { path: string; content: string }[]; dependencies: Record<string, string>; session: string }> {
        const reply = await this.ask<{ files: { path: string; content: string }[]; dependencies: Record<string, string> }>(
            prompt,
            SlytherGenerator.SCHEMA,
            session,
            cast,
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
