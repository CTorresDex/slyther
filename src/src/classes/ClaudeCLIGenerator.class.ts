// Imports
import { ProcessUtils } from "./ProcessUtils.class.ts";
import { SlytherGenerator } from "./SlytherGenerator.class.ts";
import type { SlytherRole } from "./SlytherRole.class.ts";

export class ClaudeCLIGenerator extends SlytherGenerator {
    /** The executable, overridable so a wrapper or another install can stand in. */
    private static readonly BINARY = process.env.SLYTHER_CLAUDE ?? "claude";
    /** The tools `execute` allows: enough to read, search and edit the project and to run its scripts. */
    private static readonly TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];
    /** The options a role played by the CLI may be given: the model it asks, and how hard that model thinks. */
    private static readonly OPTIONS = ["model", "effort"];
    /**
     * The aliases the CLI resolves to the newest model of a family when it runs. They are taken, and
     * pinned at the start of every build to the model they resolve to then, see #{pin}.
     */
    private static readonly FAMILIES = ["opus", "sonnet", "haiku", "fable"];
    /**
     * The aliases the CLI resolves by whoever runs it, from their settings or their plan, so two people
     * building the same project would ask different models: never taken.
     */
    private static readonly PERSONAL = ["default", "best", "opusplan"];
    /** What a role is asked to reply when an alias is resolved: as little as can be answered. */
    private static readonly PING = "Reply with just: ok";

    /**
     * What keeps the CLI from playing a role given these options: an option it does not take, no model,
     * or a model named by an alias rather than by its full id.
     */
    static problemsOf(options: Record<string, string>): string[] {
        const problems = Object.keys(options)
            .filter((option) => !ClaudeCLIGenerator.OPTIONS.includes(option))
            .map((option) => `the option "${option}" is not one the Claude CLI takes: it takes ${ClaudeCLIGenerator.OPTIONS.join(" and ")}.`);
        const model = options.model;

        if (!model) {
            problems.push(`it names no model: give it one by its full id, as model: "<model id>".`);
        } else if (ClaudeCLIGenerator.PERSONAL.includes(ClaudeCLIGenerator.aliasOf(model).base)) {
            problems.push(
                `the model "${model}" is whatever whoever runs the build chose, so two people would ask different models: name a family, like "opus" for the newest Opus, or a full id to pin one.`,
            );
        }

        return problems;
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

    /** The command line of `execute`: print mode with the editing tools allowed, resuming the session if any. */
    static executeCommand(session: string | undefined, model: string, effort = ""): string[] {
        return [
            ClaudeCLIGenerator.BINARY,
            "-p",
            "--output-format",
            "json",
            "--allowedTools",
            ClaudeCLIGenerator.TOOLS.join(","),
            "--permission-mode",
            "acceptEdits",
            ...(session ? ["--resume", session] : []),
            ...(model ? ["--model", model] : []),
            ...(effort ? ["--effort", effort] : []),
        ];
    }

    override async ask<T>(prompt: string, schema: object, session?: string, cast?: SlytherRole["cast"]): Promise<{ result: T; session: string }> {
        const { model, effort } = ClaudeCLIGenerator.optionsOf(cast);
        const reply = await this.call<{ structured_output?: T }>(ClaudeCLIGenerator.askCommand(schema, session, model, effort), prompt);

        if (reply.structured_output === undefined) {
            throw new Error(`The Claude CLI did not reply with the structured output asked for:\n${reply.result ?? ""}`);
        }

        return { result: reply.structured_output, session: reply.session_id };
    }

    override async execute(prompt: string, cwd: string, session?: string, cast?: SlytherRole["cast"]): Promise<{ text: string; session: string }> {
        const { model, effort } = ClaudeCLIGenerator.optionsOf(cast);
        const reply = await this.call(ClaudeCLIGenerator.executeCommand(session, model, effort), prompt, cwd);

        return { text: reply.result ?? "", session: reply.session_id };
    }

    /**
     * The options with a model named by the alias of a family pinned to the model the CLI resolves it to
     * now, asked with the smallest prompt there is, so every call of a build asks the same model and
     * what is recorded names it. A context window the alias asks for, like `[1m]`, is kept. A full id is
     * left as it is.
     */
    override async pin(options: Record<string, string>): Promise<Record<string, string>> {
        const model = options.model ?? "";

        if (!ClaudeCLIGenerator.FAMILIES.includes(ClaudeCLIGenerator.aliasOf(model).base)) {
            return options;
        }

        const reply = await this.call<{ modelUsage?: Record<string, unknown> }>(
            ClaudeCLIGenerator.askCommand({ type: "object", properties: {} }, undefined, model, "low"),
            ClaudeCLIGenerator.PING,
        );

        return { ...options, model: ClaudeCLIGenerator.resolvedIn(model, Object.keys(reply.modelUsage ?? {})) };
    }

    /**
     * The model an alias resolved to, among the models a reply says it used: the one of the family of the
     * alias, since the CLI also asks a small model of its own for its own work. Throws when none or more
     * than one is of the family, since guessing would record a model that was not asked.
     */
    static resolvedIn(model: string, used: string[]): string {
        const { base, suffix } = ClaudeCLIGenerator.aliasOf(model);
        const matching = used.filter((id) => id.toLowerCase().startsWith(`claude-${base}-`));

        if (matching.length !== 1) {
            throw new Error(
                `Could not tell which model "${model}" resolves to: the Claude CLI used ${used.join(", ") || "none"}. Name the model by its full id instead.`,
            );
        }

        return matching[0]!.endsWith("]") ? matching[0]! : `${matching[0]}${suffix}`;
    }

    /** The name of the model without the context window it asks for, lowercased, and that context window, like `[1m]`. */
    private static aliasOf(model: string): { base: string; suffix: string } {
        const suffix = /\[[^\]]*\]$/.exec(model)?.[0] ?? "";

        return { base: model.slice(0, model.length - suffix.length).toLowerCase(), suffix };
    }

    /** The model and the effort whoever plays the role asks with, which a cast that passed problemsOf always names a model for. */
    private static optionsOf(cast: SlytherRole["cast"] | undefined): { model: string; effort: string } {
        if (!cast?.by) {
            throw new Error(`The Claude CLI was asked ${cast ? `for the work of the ${cast.role}, which nobody plays` : "without a role"}: every call names the role it is made for, and who plays it.`);
        }

        return { model: cast.by.options.model ?? "", effort: cast.by.options.effort ?? "" };
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
