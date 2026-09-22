import { describe, expect, test } from "bun:test";
import { ClaudeCLIGenerator } from "../src/classes/ClaudeCLIGenerator.class.ts";
import { SlytherGenerator } from "../src/classes/SlytherGenerator.class.ts";

/** A generator that replies with whatever it is told to, and records what it is asked. */
class FakeGenerator extends SlytherGenerator {
    readonly prompts: { prompt: string; session?: string }[] = [];

    constructor(private readonly replies: { files: { path: string; content: string }[]; dependencies?: Record<string, string> }[]) {
        super();
    }

    override async ask<T>(prompt: string, schema: object, session?: string): Promise<{ result: T; session: string }> {
        this.prompts.push({ prompt, session });

        return { result: this.replies.shift() as T, session: `s${this.prompts.length}` };
    }

    override async execute(): Promise<{ text: string; session: string }> {
        return { text: "", session: "e" };
    }
}

const TASK = {
    instructions: "Write locate.",
    context: [{ path: "src/a.ts", content: "export const a = 1" }],
    expected: ["k/locate/locate.ts"],
    dependencies: { "web-tree-sitter": "0.25.3" },
};

describe("SlytherGenerator", () => {
    test("generate asks with the instructions, the context and the dependencies and returns the files", async () => {
        const generator = new FakeGenerator([{ files: [{ path: "k/locate/locate.ts", content: "x" }], dependencies: {} }]);
        const reply = await generator.generate(TASK);

        expect(reply.files).toEqual([{ path: "k/locate/locate.ts", content: "x" }]);
        expect(reply.dependencies).toEqual({});
        expect(reply.session).toBe("s1");
        expect(generator.prompts[0]!.session).toBeUndefined();
        expect(generator.prompts[0]!.prompt).toContain("Write locate.");
        expect(generator.prompts[0]!.prompt).toContain("### src/a.ts");
        expect(generator.prompts[0]!.prompt).toContain("- web-tree-sitter: 0.25.3");
        expect(generator.prompts[0]!.prompt).toContain("`k/locate/locate.ts`");
    });

    test("fix resumes the session with the failure", async () => {
        const generator = new FakeGenerator([
            { files: [{ path: "a", content: "1" }] },
            { files: [{ path: "a", content: "2" }] },
        ]);
        const first = await generator.generate({ ...TASK, expected: ["a"] });
        const fixed = await generator.fix(first.session, "a does not parse", ["a"]);

        expect(fixed.files[0]!.content).toBe("2");
        expect(generator.prompts[1]!.session).toBe("s1");
        expect(generator.prompts[1]!.prompt).toContain("a does not parse");
    });

    test("throws when the reply lacks a file or adds one", async () => {
        const generator = new FakeGenerator([{ files: [{ path: "b", content: "" }] }]);

        expect(generator.generate({ ...TASK, expected: ["a"] })).rejects.toThrow(
            'The generator replied with the wrong files: "a" is missing, "b" was not asked for.',
        );
    });
});

describe("ClaudeCLIGenerator", () => {
    test("ask runs in print mode with no tools, the schema and the session", () => {
        expect(ClaudeCLIGenerator.askCommand({ type: "object" }, "abc", "opus")).toEqual([
            "claude", "-p", "--output-format", "json", "--json-schema", '{"type":"object"}', "--tools", "", "--resume", "abc", "--model", "opus",
        ]);
        expect(ClaudeCLIGenerator.askCommand({}, undefined, "")).not.toContain("--resume");
        expect(ClaudeCLIGenerator.askCommand({}, undefined, "")).not.toContain("--effort");
        expect(ClaudeCLIGenerator.askCommand({}, undefined, "", "low").slice(-2)).toEqual(["--effort", "low"]);
    });

    test("execute allows the editing tools, and resumes the session it is given", () => {
        const command = ClaudeCLIGenerator.executeCommand(undefined, "");

        expect(command).toContain("--allowedTools");
        expect(command[command.indexOf("--allowedTools") + 1]).toBe("Read,Glob,Grep,Edit,Write,Bash");
        expect(command).toContain("acceptEdits");
        expect(command).not.toContain("--resume");

        const resumed = ClaudeCLIGenerator.executeCommand("s1", "");

        expect(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2)).toEqual(["--resume", "s1"]);
    });
});
