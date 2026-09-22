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
    /** What it was told to write every script from, keyed by the path of the script. */
    readonly prompts: Record<string, string> = {};

    constructor(readonly scripts: Record<string, string | string[]>) {
        super();
    }

    override async ask<T>(prompt: string, schema: object, session?: string): Promise<{ result: T; session: string }> {
        const path = /`([^`]+)`\.$/m.exec(prompt)![1]!;
        const registered = this.scripts[path];
        const content = Array.isArray(registered) ? (registered.length > 1 ? registered.shift()! : registered[0]!) : registered;

        (session ? this.fixed : this.asked).push(path);
        this.prompts[path] = prompt;

        return { result: { files: [{ path, content: `${content}\n` }], dependencies: {} } as T, session: "s" };
    }

    override async execute(prompt: string): Promise<{ text: string; session: string }> {
        return { text: `executed:${prompt}`, session: "e" };
    }
}

const ARTIFACTS = ".slyther/artifacts";
const SCRIPTS = {
    "k/locate/locate.sh": '[ "$1" = "a" ] && echo src/a.txt && exit 0; exit 1',
    "k/list/list.sh": "echo a",
    "k/signature/signature.sh": "echo 'name string'",
    "k/uses/uses.sh": "exit 0",
    "k/create/scaffold.sh": 'echo "scaffold $1 $2"',
};
const SPEC = (step = "makes the file") => `@lang "sh"
@artifact k (content: string) {
    rules of k
    operation locate: deterministic { prints src/{id}.txt }
    operation create {
        deterministic scaffold { ${step} }
        llm fill { fills the file }
    }
    operation evaluate (id) {
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
            role: "engineer",
            steps: [
                { name: "scaffold", kind: "deterministic", path: "k/create/scaffold.sh", lang: "sh", run: ["sh", ".slyther/artifacts/k/create/scaffold.sh"], role: "scribe" },
                { name: "fill", kind: "llm", path: "k/create/fill.md", role: "engineer" },
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
            `@lang "sh"\n@artifact k {\n rules of k\n operation locate: deterministic { prints src/{id}.txt }\n}${INSTANCES}`,
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
@artifact k (content: string) ref "./rules.md"
operation k::locate: deterministic { prints src/{id}.txt }
operation k::create {
    deterministic scaffold ref "./scaffold.md"
    llm fill { fills the file }
}
operation k::evaluate (id) { checks the file }`;
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
@artifact c (parts: string) {
    a composite
    operation expand: deterministic { prints a #{k} per part }
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
        expect(prompt).toContain("### k, which takes content (string)\n\nrules of k");
        expect((await manifest()).operations["c::expand"].params.map((param: { name: string }) => param.name)).toEqual(["id", "parts"]);
    });

    test("an expand that prints what is not accepted fails verification", async () => {
        const generator = new FakeGenerator({ ...SCRIPTS, "c/expand/expand.sh": 'echo "c nested { x }"' });

        expect(build(generator, COMPOSITE, 1)).rejects.toThrow(
            'c/expand/expand.sh printed declarations that are not accepted:\nc:sample emitted the c "sample::nested", but its expand does not reference c: it may only emit k.',
        );
    });

    test("a script is only offered the operations built before it, so none can run one that runs it back", async () => {
        const generator = new FakeGenerator(SCRIPTS);

        await build(generator);

        const offered = (path: string) =>
            (generator.prompts[path]!.split("- The operations of the kind built before this one")[1] ?? "")
                .split("\n")
                .filter((line) => line.startsWith("- "))
                .map((line) => line.slice(2, line.indexOf(" ", 2)));

        // locate is built first, so it is offered nothing: what made it run list, which ran it back.
        expect(offered("k/locate/locate.sh")).toEqual([]);
        expect(offered("k/list/list.sh")).toEqual(["locate"]);
        expect(offered("k/signature/signature.sh")).toEqual(["locate", "list"]);
        // signature and uses are written side by side, so neither is offered the other.
        expect(offered("k/uses/uses.sh")).toEqual(["locate", "list"]);
        expect(offered("k/create/scaffold.sh").sort()).toEqual(["list", "locate", "signature", "uses"]);
    });

    test("a rebuild of an operation is still only offered the ones built before it", async () => {
        const generator = new FakeGenerator(SCRIPTS);

        await build(generator);
        await rm(join(root, ARTIFACTS, "k/locate/locate.sh"));

        const rebuilt = new FakeGenerator(SCRIPTS);

        // Everything is in the manifest now, and locate must still not be told of the operations built after it.
        await build(rebuilt);

        expect(rebuilt.asked).toEqual(["k/locate/locate.sh"]);
        expect(rebuilt.prompts["k/locate/locate.sh"]).not.toContain("- The operations of the kind built before this one");
    });
});

/** Takes a while to write every script, and records when each started and finished, and how many were written at once. */
class SlowGenerator extends FakeGenerator {
    readonly events: string[] = [];
    most = 0;
    private writing = 0;

    override async ask<T>(prompt: string, schema: object, session?: string): Promise<{ result: T; session: string }> {
        const path = /`([^`]+)`\.$/m.exec(prompt)![1]!;

        this.events.push(`start ${path}`);
        this.most = Math.max(this.most, ++this.writing);
        await Bun.sleep(40);
        this.writing--;
        this.events.push(`end ${path}`);

        return super.ask<T>(prompt, schema, session);
    }

    /** Whether the first event happened before the second. */
    before(first: string, second: string): boolean {
        return this.events.indexOf(first) < this.events.indexOf(second);
    }
}

describe("SlytherArtifactBuilder side by side", () => {
    test("a script waits for what it is offered, and signature and uses are written at once", async () => {
        const generator = new SlowGenerator(SCRIPTS);

        await build(generator);

        expect(generator.before("end k/locate/locate.sh", "start k/list/list.sh")).toBe(true);
        expect(generator.before("end k/list/list.sh", "start k/signature/signature.sh")).toBe(true);
        expect(generator.before("start k/uses/uses.sh", "end k/signature/signature.sh")).toBe(true);
        expect(generator.before("end k/signature/signature.sh", "start k/create/scaffold.sh")).toBe(true);
        expect(generator.before("end k/uses/uses.sh", "start k/create/scaffold.sh")).toBe(true);
        expect(generator.most).toBe(2);
    });

    const KINDS = `@lang "sh"
@artifact k {
    rules of k
    operation locate: deterministic { prints src/{id}.txt }
}
@artifact j {
    rules of j
    operation locate: deterministic { prints src/{id}.md }
}
@artifact h {
    rules of h
    operation locate: deterministic { prints src/{id}.h }
}`;
    const LOCATES = Object.fromEntries(["k", "j", "h"].flatMap((kind) => [[`${kind}/locate/locate.sh`, "exit 1"], [`${kind}/list/list.sh`, "true"]]));

    test("the scripts of different kinds are written side by side, up to the concurrency", async () => {
        const wide = new SlowGenerator(LOCATES);
        const narrow = new SlowGenerator(LOCATES);

        await new SlytherArtifactBuilder(root, ARTIFACTS, wide).build(kindsOf(KINDS));
        expect(wide.most).toBe(3);

        await rm(join(root, ARTIFACTS), { recursive: true, force: true });
        await new SlytherArtifactBuilder(root, ARTIFACTS, narrow, { concurrency: 2 }).build(kindsOf(KINDS));
        expect(narrow.most).toBe(2);
        expect(narrow.asked.sort()).toEqual(Object.keys(LOCATES).sort());
    });

    test("once a script fails, what waits for it is never written, and what was under way is kept", async () => {
        const generator = new SlowGenerator({ ...SCRIPTS, "k/signature/signature.sh": "echo broken" });

        expect(build(generator, SPEC(), 1)).rejects.toThrow("k/signature/signature.sh failed verification 1 times:");
        await Bun.sleep(400);

        expect(generator.asked).not.toContain("k/create/scaffold.sh");
        expect(generator.asked).toContain("k/uses/uses.sh");
        expect((await manifest()).files["k/uses/uses.sh"]).toBeDefined();
        expect((await manifest()).files["k/signature/signature.sh"]).toBeUndefined();
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
