// Imports
import { SlytherGenerator } from "./SlytherGenerator.class.ts";
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

    override async ask<T>(prompt: string, schema: object, session?: string): Promise<{ result: T; session: string }> {
        this.log(SlytherTracedGenerator.block(session ? `asking the llm, resuming session ${session}` : "asking the llm", prompt));

        const started = Date.now();
        const reply = await this.inner.ask<T>(prompt, schema, session);

        this.log(SlytherTracedGenerator.block(`llm reply (${StringUtils.duration(Date.now() - started)}, session ${reply.session})`, JSON.stringify(reply.result, null, 4)));

        return reply;
    }

    override async execute(prompt: string, cwd: string): Promise<string> {
        this.log(SlytherTracedGenerator.block(`executing with the llm in ${cwd}`, prompt));

        const started = Date.now();
        const reply = await this.inner.execute(prompt, cwd);

        this.log(SlytherTracedGenerator.block(`llm reply (${StringUtils.duration(Date.now() - started)})`, reply || "(nothing)"));

        return reply;
    }

    private static block(heading: string, body: string): string {
        return `── ${heading} ${SlytherTracedGenerator.RULE.slice(heading.length + 4)}\n${body.trimEnd()}\n${SlytherTracedGenerator.RULE}`;
    }
}
