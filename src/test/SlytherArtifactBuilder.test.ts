import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherArtifactBuilder } from "../src/classes/SlytherArtifactBuilder.class.ts";
import { SlytherArtifactKind } from "../src/classes/SlytherArtifactKind.class.ts";
import { SlytherGenerator } from "../src/classes/SlytherGenerator.class.ts";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherProject } from "../src/classes/SlytherProject.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

/** Replies with the sh script registered for every path, and counts what it is asked. */
class FakeGenerator extends SlytherGenerator {
    readonly asked: string[] = [];
    readonly fixed: string[] = [];

    constructor(readonly scripts: Record<string, string | string[]>) {
        super();
    }

    override async ask<T>(prompt: string, schema: object, session?: string): Promise<{ result: T; session: string }> {
        const path = /`([^`]+)`\.$/m.exec(prompt)![1]!;
        const registered = this.scripts[path];
        const content = Array.isArray(registered) ? (registered.length > 1 ? registered.shift()! : registered[0]!) : registered;

        (session ? this.fixed : this.asked).push(path);

        return { result: { files: [{ path, content: `${content}\n` }], dependencies: {} } as T, session: "s" };
    }

    override async execute(prompt: string): Promise<string> {
        return `executed:${prompt}`;
    }
}

const ARTIFACTS = ".slyther/artifacts";
const SCRIPTS = {
    "k/locate/locate.sh": '[ "$1" = "a" ] && echo src/a.txt && exit 0; exit 1',
    "k/list/list.sh": "echo a",
    "k/signature/signature.sh": "echo 'name string'",
    "k/uses/uses.sh": "exit 1",
    "k/create/scaffold.sh": 'echo "scaffold $1 $2"',
};
const SPEC = (step = "makes the file") => `@lang "sh"
@artifact k {
    rules of k
    operation locate (id: string): deterministic { prints src/{id}.txt }
    operation create (id: string, content: string) {
        deterministic scaffold { ${step} }
        llm fill { fills the file }
    }
    operation evaluate (id: string) {
        llm check { checks the file }
    }
}${INSTANCES}`;
/** Two instances, one referencing the other, so the kind is asked for signature and uses. */
const INSTANCES = "\nk a { the a }\nk b { uses #{a} }";

let root = "";
const kindsOf = (spec: string) => SlytherArtifactKind.of(new SlytherParser().parse(new SlytherScript(spec)));
const build = (generator: FakeGenerator, spec = SPEC(), attempts?: number) =>
    new SlytherArtifactBuilder(root, ARTIFACTS, generator, { attempts }).build(kindsOf(spec));
const read = (path: string) => readFile(join(root, ARTIFACTS, path), "utf-8");
const manifest = async () => JSON.parse(await read("manifest.json"));
const exists = (path: string) => stat(join(root, ARTIFACTS, path)).then(() => true, () => false);

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "slyther-builder-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("SlytherArtifactBuilder", () => {
    test("builds a script per deterministic step and a markdown per llm step and per operation", async () => {
        const generator = new FakeGenerator(SCRIPTS);
        const report = await build(generator);

        expect(report.map((entry) => `${entry.status} ${entry.path}`)).toEqual([
            "built k/locate/locate.sh",
            "built k/list/list.sh",
            "built k/signature/signature.sh",
            "built k/uses/uses.sh",
            "built k/create/scaffold.sh",
            "built k/create/fill.md",
            "built k/create/operation.md",
            "built k/evaluate/check.md",
            "built k/evaluate/operation.md",
        ]);
        expect(generator.asked).toEqual(Object.keys(SCRIPTS));
        expect(await read("k/create/scaffold.sh")).toBe('echo "scaffold $1 $2"\n');
        expect(await read("k/create/operation.md")).toContain(
            '1. Run `sh .slyther/artifacts/k/create/scaffold.sh "{id}" "{content}"`. If it exits with a code other than 0, stop and report its output.',
        );
        expect(await read("k/create/operation.md")).toContain("2. Follow `.slyther/artifacts/k/create/fill.md`.");
        expect(await read("k/create/fill.md")).toContain("rules of k");
        expect(await read("k/create/fill.md")).toContain("fills the file");

        const recorded = await manifest();

        expect(recorded.operations["k::create"]).toEqual({
            kind: "k",
            name: "create",
            deterministic: false,
            params: [
                { name: "id", type: "string", optional: false },
                { name: "content", type: "string", optional: false },
            ],
            entry: "k/create/operation.md",
            steps: [
                { name: "scaffold", kind: "deterministic", path: "k/create/scaffold.sh", lang: "sh", run: ["sh", ".slyther/artifacts/k/create/scaffold.sh"] },
                { name: "fill", kind: "llm", path: "k/create/fill.md" },
            ],
        });
        expect(recorded.operations["k::locate"].entry).toBeUndefined();
        expect(Object.keys(recorded.files).sort()).toEqual(report.map((entry) => entry.path).sort());
        expect(await exists(".gitignore")).toBe(false);
    });

    test("a second build keeps everything and asks the generator nothing", async () => {
        await build(new FakeGenerator(SCRIPTS));

        const generator = new FakeGenerator(SCRIPTS);
        const report = await build(generator);

        expect(report.every((entry) => entry.status === "kept")).toBe(true);
        expect(generator.asked).toEqual([]);
    });

    test("rebuilds only the step whose source changed", async () => {
        await build(new FakeGenerator(SCRIPTS));

        const generator = new FakeGenerator(SCRIPTS);
        const report = await build(generator, SPEC("makes the file differently"));

        expect(report.filter((entry) => entry.status === "rebuilt").map((entry) => entry.path)).toEqual([
            "k/create/scaffold.sh",
            "k/create/operation.md",
        ]);
        expect(generator.asked).toEqual(["k/create/scaffold.sh"]);
    });

    test("rebuilds a file edited by hand and a file that is missing", async () => {
        await build(new FakeGenerator(SCRIPTS));
        await writeFile(join(root, ARTIFACTS, "k/list/list.sh"), "echo edited\n");
        await rm(join(root, ARTIFACTS, "k/evaluate/check.md"));

        const report = await build(new FakeGenerator(SCRIPTS));

        expect(report.filter((entry) => entry.status === "rebuilt").map((entry) => entry.path)).toEqual([
            "k/list/list.sh",
            "k/evaluate/check.md",
        ]);
        expect(await read("k/list/list.sh")).toBe("echo a\n");
    });

    test("removes the files of an operation that is gone and prunes its folder", async () => {
        await build(new FakeGenerator(SCRIPTS));

        const report = await build(
            new FakeGenerator(SCRIPTS),
            `@lang "sh"\n@artifact k {\n rules of k\n operation locate (id: string): deterministic { prints src/{id}.txt }\n}${INSTANCES}`,
        );

        expect(report.filter((entry) => entry.status === "removed").map((entry) => entry.path).sort()).toEqual([
            "k/create/fill.md",
            "k/create/operation.md",
            "k/create/scaffold.sh",
            "k/evaluate/check.md",
            "k/evaluate/operation.md",
        ]);
        expect(await exists("k/create")).toBe(false);
        expect((await manifest()).operations["k::create"]).toBeUndefined();
    });

    test("sends a script that fails verification back to be fixed, and gives up after the attempts", async () => {
        const generator = new FakeGenerator({ ...SCRIPTS, "k/list/list.sh": ["exit 2", "exit 2", "echo a"] });

        await build(generator);

        expect(generator.fixed).toEqual(["k/list/list.sh", "k/list/list.sh"]);
        expect(await read("k/list/list.sh")).toBe("echo a\n");
    });

    test("list must print ids locate finds", async () => {
        const generator = new FakeGenerator({ ...SCRIPTS, "k/list/list.sh": ["echo b", "echo a"] });

        await build(generator);

        expect(generator.fixed).toEqual(["k/list/list.sh"]);
    });

    test("gives up on a script that never passes, leaving it unrecorded", async () => {
        const stubborn = new FakeGenerator({ ...SCRIPTS, "k/signature/signature.sh": "echo broken" });

        expect(build(stubborn, SPEC(), 2)).rejects.toThrow("k/signature/signature.sh failed verification 2 times:");
        await build(stubborn, SPEC(), 2).catch(() => {});
        expect((await manifest()).files["k/signature/signature.sh"]).toBeUndefined();
        expect((await manifest()).files["k/locate/locate.sh"]).toBeDefined();
    });

    test("tells the generator about the other operations of the kind", async () => {
        const generator = new FakeGenerator(SCRIPTS);
        const prompts: string[] = [];

        generator.ask = async function <T>(this: FakeGenerator, prompt: string, schema: object, session?: string) {
            prompts.push(prompt);

            return FakeGenerator.prototype.ask.call(this, prompt, schema, session) as Promise<{ result: T; session: string }>;
        };

        await build(generator);

        expect(prompts[4]).toContain("Write the script `k/create/scaffold.sh` in sh");
        expect(prompts[4]).toContain("- locate (id: string): run `sh .slyther/artifacts/k/locate/locate.sh <id>`");
        expect(prompts[4]).toContain("## Rules of every k\n\nrules of k");
        expect(prompts[4]).toContain("## Step scaffold\n\nmakes the file");
    });
});

describe("SlytherArtifactBuilder ref", () => {
    test("reads a ref into what it asks the generator, and only points at it in the markdown of an llm step", async () => {
        await writeFile(join(root, "rules.md"), "the rules in a file");
        await writeFile(join(root, "scaffold.md"), "the scaffold in a file");

        const prompts: string[] = [];
        const generator = new (class extends FakeGenerator {
            override async ask<T>(prompt: string, schema: object, session?: string) {
                prompts.push(prompt);

                return super.ask<T>(prompt, schema, session);
            }
        })(SCRIPTS);
        const spec = `@lang "sh"
@artifact k ref "./rules.md"
operation k::locate (id: string): deterministic { prints src/{id}.txt }
operation k::create (id: string, content: string) {
    deterministic scaffold ref "./scaffold.md"
    llm fill { fills the file }
}
operation k::evaluate (id: string) { checks the file }`;
        const kinds = SlytherArtifactKind.of(new SlytherParser().parse(new SlytherScript(spec, join(root, "main.sly")), root));

        await new SlytherArtifactBuilder(root, ARTIFACTS, generator).build(kinds);

        const scaffold = prompts.find((prompt) => prompt.includes("`k/create/scaffold.sh`"))!;

        expect(scaffold).toContain("the rules in a file");
        expect(scaffold).toContain("the scaffold in a file");
        expect(await read("k/create/fill.md")).toContain("Read `rules.md`: it holds the prose of artifact k.");
        expect(await read("k/create/fill.md")).not.toContain("the rules in a file");
    });
});

describe("SlytherArtifactBuilder expand", () => {
    const COMPOSITE = `${SPEC()}
@artifact c {
    a composite
    operation expand (id: string, parts: string): deterministic { prints a #{k} per part }
}`;
    const EXPAND = { "c/expand/expand.sh": 'for part in $2; do echo "k $part { the $part }"; done' };

    test("tells the generator what an expand prints and which kinds it may emit, and verifies what it prints", async () => {
        const generator = new FakeGenerator({ ...SCRIPTS, ...EXPAND });
        const prompts: string[] = [];

        generator.ask = async function <T>(this: FakeGenerator, prompt: string, schema: object, session?: string) {
            prompts.push(prompt);

            return FakeGenerator.prototype.ask.call(this, prompt, schema, session) as Promise<{ result: T; session: string }>;
        };

        const report = await build(generator, COMPOSITE);
        const prompt = prompts.find((candidate) => candidate.includes("Write the script `c/expand/expand.sh`"))!;

        expect(report.map((entry) => entry.path)).toContain("c/expand/expand.sh");
        expect(prompt).toContain("## What it prints");
        expect(prompt).toContain("`endpoint create` printed for `Users` declares `Users::create`");
        expect(prompt).toContain("### k, whose create needs content (string)\n\nrules of k");
        expect((await manifest()).operations["c::expand"].params.map((param: { name: string }) => param.name)).toEqual(["id", "parts"]);
    });

    test("an expand that prints what is not accepted fails verification", async () => {
        const generator = new FakeGenerator({ ...SCRIPTS, "c/expand/expand.sh": 'echo "c nested { x }"' });

        expect(build(generator, COMPOSITE, 1)).rejects.toThrow(
            'c/expand/expand.sh printed declarations that are not accepted:\nc:sample emitted the c "sample::nested", but its expand does not reference c: it may only emit k.',
        );
    });
});

describe("SlytherProject run", () => {
    test("runs a deterministic operation and prints the markdown of one that is not", async () => {
        await writeFile(join(root, "main.sly"), SPEC().replace(INSTANCES, ""));

        const project = new SlytherProject(root, new FakeGenerator(SCRIPTS));

        await project.build();

        expect((await project.runOperation("k", "locate", ["a"])).code).toBe(0);
        expect((await project.runOperation("k", "locate", ["b"])).code).toBe(1);

        const printed = await project.runOperation("k", "create", ["a", "hello"]);

        expect(printed.code).toBe(0);
        expect(printed.output).toContain('sh ../artifacts/k/create/scaffold.sh "a" "hello"');

        const executed = await project.runOperation("k", "create", ["a", "hello"], { execute: new FakeGenerator({}) });

        expect(executed.output).toStartWith("executed:# k::create");
        expect(project.runOperation("k", "create", ["a"])).rejects.toThrow('The operation "k::create" takes (id: string, content: string), not 1 argument.');
        expect(project.runOperation("k", "nope", [])).rejects.toThrow('The operation "k::nope" is not built');
    });
});
