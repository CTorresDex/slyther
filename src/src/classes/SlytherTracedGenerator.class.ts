// Imports
import { SlytherGenerator } from "./SlytherGenerator.class.ts";
import { SlytherRole } from "./SlytherRole.class.ts";
import { StringUtils } from "./StringUtils.class.ts";

export class SlytherTracedGenerator extends SlytherGenerator {
    /** How a heading is filled out to a readable width. */
    private static readonly RULE = "─".repeat(60);

    constructor(
        /** The generator every call is handed to. */
        private readonly inner: SlytherGenerator,
        /** Where every prompt and every reply is printed. */
        private readonly log: (line: string) => void,
    ) {
        super();
    }

    override async ask<T>(prompt: string, schema: object, session?: string, cast?: SlytherRole["cast"]): Promise<{ result: T; session: string }> {
        const asking = `asking the llm${SlytherTracedGenerator.as(cast)}`;

        this.log(SlytherTracedGenerator.block(session ? `${asking}, resuming session ${session}` : asking, prompt));

        const started = Date.now();
        const reply = await this.inner.ask<T>(prompt, schema, session, cast);

        this.log(SlytherTracedGenerator.block(`llm reply (${StringUtils.duration(Date.now() - started)}, session ${reply.session})`, JSON.stringify(reply.result, null, 4)));

        return reply;
    }

    override async execute(prompt: string, cwd: string, session?: string, cast?: SlytherRole["cast"]): Promise<{ text: string; session: string }> {
        const executing = `executing with the llm${SlytherTracedGenerator.as(cast)} in ${cwd}`;

        this.log(SlytherTracedGenerator.block(session ? `${executing}, resuming session ${session}` : executing, prompt));

        const started = Date.now();
        const reply = await this.inner.execute(prompt, cwd, session, cast);

        this.log(SlytherTracedGenerator.block(`llm reply (${StringUtils.duration(Date.now() - started)}, session ${reply.session})`, reply.text || "(nothing)"));

        return reply;
    }

    override problemsWith(casts: SlytherRole["cast"][]): string[] {
        return this.inner.problemsWith(casts);
    }

    override pin(options: Record<string, string>): Promise<Record<string, string>> {
        return this.inner.pin(options);
    }

    override pinRoles(roles: Map<string, SlytherRole["binding"]>, named: string[]): Promise<Map<string, SlytherRole["binding"]>> {
        return this.inner.pinRoles(roles, named);
    }

    /** Who is asked, as the heading of a block says it. */
    private static as(cast: SlytherRole["cast"] | undefined): string {
        return cast ? ` as ${SlytherRole.labelOf(cast)}` : "";
    }

    private static block(heading: string, body: string): string {
        return `── ${heading} ${SlytherTracedGenerator.RULE.slice(heading.length + 4)}\n${body.trimEnd()}\n${SlytherTracedGenerator.RULE}`;
    }
}
