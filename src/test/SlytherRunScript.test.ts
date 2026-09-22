import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherArtifactBuilder } from "../src/classes/SlytherArtifactBuilder.class.ts";
import { SlytherArtifactKind } from "../src/classes/SlytherArtifactKind.class.ts";
import { SlytherGenerator } from "../src/classes/SlytherGenerator.class.ts";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherProject } from "../src/classes/SlytherProject.class.ts";
import { SlytherRunScript } from "../src/classes/SlytherRunScript.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

/** Writes the sh script registered for every path, and reviews with the verdicts it is given, passing once they run out. */
class FakeGenerator extends SlytherGenerator {
    readonly asked: string[] = [];
    readonly fixed: string[] = [];
    readonly reviewed: { prompt: string; session?: string }[] = [];

    constructor(
        readonly scripts: Record<string, string>,
        readonly verdicts: { pass: boolean; errors: string[] }[] = [],
    ) {
        super();
    }

    override async ask<T>(prompt: string, schema: object, session?: string): Promise<{ result: T; session: string }> {
        if ("pass" in ((schema as { properties: object }).properties)) {
            this.reviewed.push({ prompt, session });

            return { result: (this.verdicts.shift() ?? { pass: true, errors: [] }) as T, session: "r" };
        }

        const path = /`([^`]+)`\.$/m.exec(prompt)![1]!;

        (session ? this.fixed : this.asked).push(path);

        return { result: { files: [{ path, content: `${this.scripts[path]}\n` }], dependencies: {} } as T, session: "s" };
    }

    override async execute(): Promise<{ text: string; session: string }> {
        return { text: "", session: "e" };
    }
}

const parse = (source: string) => new SlytherParser().parse(new SlytherScript(source));
const scriptsOf = (source: string) => SlytherRunScript.of(parse(source));

describe("SlytherParser @run", () => {
    test("declares a script named default in the run namespace, whatever @use is in effect", () => {
        const parsed = parse('@lang "sh"\n@use Server\n@run {\n    starts the server\n}');
        const artifact = parsed.artifacts.find((candidate) => candidate.artifact === "run")!;

        expect(artifact.name).toBe("run::default");
        expect(artifact.content).toBe("starts the server");
    });

    test("reads the params from the first parens and the configuration from the second", () => {
        const [script] = scriptsOf('@run dev (port: number?, host: string) (lang: "sh") { serves on {port} }');

        expect(script!.name).toBe("dev");
        expect(script!.params).toEqual([
            { name: "port", type: "number", optional: true },
            { name: "host", type: "string", optional: false },
        ]);
        expect(script!.lang).toBe("sh");
    });

    test("a single paren holds either the params or the configuration", () => {
        expect(scriptsOf('@run a (lang: "sh") { x }')[0]!.lang).toBe("sh");
        expect(scriptsOf('@lang "sh"\n@run a (port: number) { x }')[0]!.params).toEqual([{ name: "port", type: "number", optional: false }]);
        expect(() => parse('@run a (port: number, lang: "sh") { x }')).toThrow("takes its params and its configuration in separate parens");
        expect(() => parse('@run a (lang: "sh") (port: number) { x }')).toThrow("takes its params in the first parens and its configuration in the second");
    });

    test("throws without braces, with an llm step, on a repeated name and on @artifact run", () => {
        expect(() => parse("@run dev")).toThrow('The script "dev" declared with @run must have a body in braces, or take it from a file with from or ref.');
        expect(() => parse('@lang "sh"\n@run {\n    llm think { x }\n}')).toThrow('"llm" cannot be declared inside run "run::default"');
        expect(() => parse("@run a { x }\n@run a { y }")).toThrow('Duplicate declaration "run::a".');
        expect(() => parse("@artifact run")).toThrow('"run" is the kind of the scripts declared with @run');
    });

    test("a script does not take the name of an artifact", () => {
        expect(() => parse("@artifact command\ncommand build { x }\n@run build { y }")).not.toThrow();
    });
});

describe("SlytherRunScript", () => {
    test("without steps, its content is its only step, named after the script, in the lang of the project", () => {
        const [script] = scriptsOf('@lang "ts"\n@run dev { serves }');

        expect(script!.steps.map((step) => [step.artifact.name, step.artifact.content, step.lang])).toEqual([["run::dev::dev", "serves", "ts"]]);
        expect(script!.steps[0]!.closureHash).toBe(script!.closureHash);
    });

    test("its steps run in the order written, each in its own lang, else the script's", () => {
        const [script] = scriptsOf('@lang "ts"\n@run setup (lang: "py") {\n    deterministic install (lang: "sh") { installs }\n    deterministic migrate { migrates }\n}');

        expect(script!.steps.map((step) => [step.artifact.name, step.lang])).toEqual([
            ["run::setup::install", "sh"],
            ["run::setup::migrate", "py"],
        ]);
    });

    test("throws when a step has no lang or declares params", () => {
        expect(() => scriptsOf("@run dev { serves }")).toThrow('Step "run::dev::dev" has no lang');
        expect(() => scriptsOf('@lang "sh"\n@run dev {\n    deterministic a (port: number) { x }\n}')).toThrow("a step receives the params of its script");
    });

    test("knows the artifacts it references, and a kind does not take its steps as its own", () => {
        const source = '@lang "sh"\n@artifact class\nclass Server { listens }\n@run {\n    deterministic start { starts #{Server} }\n}';

        expect(scriptsOf(source)[0]!.references.map((artifact) => artifact.name)).toEqual(["Server"]);
        expect(() => SlytherArtifactKind.of(parse(source))).not.toThrow();
    });
});

const SPEC = `@lang "sh"
@artifact k {
    rules of k
    operation locate: deterministic { prints src/{id}.txt }
}
@run { writes started }
@run setup (name: string) {
    deterministic first { writes first }
    deterministic second { writes second }
}`;
const SCRIPTS = {
    "k/locate/locate.sh": "exit 1",
    "k/list/list.sh": "exit 0",
    "@run/default/default.sh": "echo started > started.txt",
    "@run/setup/first.sh": 'echo "first $1" > setup.txt; [ "$1" != fail ]',
    "@run/setup/second.sh": 'echo second >> setup.txt',
};
const ARTIFACTS = ".slyther/artifacts";

let root = "";

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "slyther-run-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("SlytherArtifactBuilder scripts", () => {
    const build = (generator: FakeGenerator, spec = SPEC) => {
        const parsed = parse(spec);

        return new SlytherArtifactBuilder(root, ARTIFACTS, generator).build(SlytherArtifactKind.of(parsed), SlytherRunScript.of(parsed));
    };

    test("builds a script per step after the operations, reviews each and records the scripts", async () => {
        const generator = new FakeGenerator(SCRIPTS);
        const report = await build(generator);

        expect(report.map((entry) => `${entry.status} ${entry.path}`)).toEqual(Object.keys(SCRIPTS).map((path) => `built ${path}`));
        expect(generator.reviewed.length).toBe(3);
        expect(generator.reviewed.every((review) => review.session === undefined)).toBe(true);
        expect(generator.reviewed[1]!.prompt).toContain("## Step first\n\nwrites first");
        expect(generator.reviewed[1]!.prompt).toContain('echo "first $1" > setup.txt');

        const manifest = JSON.parse(await readFile(join(root, ARTIFACTS, "manifest.json"), "utf-8"));

        expect(manifest.scripts.setup).toEqual({
            name: "setup",
            params: [{ name: "name", type: "string", optional: false }],
            steps: [
                { name: "first", path: "@run/setup/first.sh", lang: "sh", run: ["sh", ".slyther/artifacts/@run/setup/first.sh"] },
                { name: "second", path: "@run/setup/second.sh", lang: "sh", run: ["sh", ".slyther/artifacts/@run/setup/second.sh"] },
            ],
        });
    });

    test("tells the generator how the script runs and which operations it may run", async () => {
        const generator = new FakeGenerator(SCRIPTS);

        await build(generator);

        const prompt = generator.reviewed[0]!.prompt;

        expect(prompt).toContain('Write the script `@run/default/default.sh` in sh: the script "default" that runs the project.');
        expect(prompt).toContain("may run for as long as the project does");
        expect(prompt).toContain("- k locate (id: string): run `sh .slyther/artifacts/k/locate/locate.sh <id>`");
    });

    test("sends the errors of a review back to be fixed, and keeps what did not change", async () => {
        const generator = new FakeGenerator(SCRIPTS, [{ pass: false, errors: ["it never writes started"] }]);

        await build(generator);

        expect(generator.fixed).toEqual(["@run/default/default.sh"]);

        const again = new FakeGenerator(SCRIPTS);
        const report = await build(again, SPEC.replace("writes second", "appends second"));

        expect(report.filter((entry) => entry.status !== "kept").map((entry) => `${entry.status} ${entry.path}`)).toEqual(["rebuilt @run/setup/second.sh"]);
        expect(again.reviewed.length).toBe(1);
    });

    test("removes the files of a script that is gone", async () => {
        await build(new FakeGenerator(SCRIPTS));

        const report = await build(new FakeGenerator(SCRIPTS), SPEC.replace("@run { writes started }", ""));

        expect(report.filter((entry) => entry.status === "removed").map((entry) => entry.path)).toEqual(["@run/default/default.sh"]);
    });
});

describe("SlytherProject run", () => {
    test("runs the steps of a script in order from the source folder with the args, stopping at the first that fails", async () => {
        await writeFile(join(root, "main.sly"), SPEC);

        const project = new SlytherProject(root, new FakeGenerator(SCRIPTS));
        const src = join(root, ".slyther", "src");

        await project.build();

        expect(await project.scripts()).toEqual(["default", "setup"]);
        expect(await project.run()).toBe(0);
        expect(await readFile(join(src, "started.txt"), "utf-8")).toBe("started\n");
        expect(await project.run("setup", ["ok"])).toBe(0);
        expect(await readFile(join(src, "setup.txt"), "utf-8")).toBe("first ok\nsecond\n");
        expect(await project.run("setup", ["fail"])).toBe(1);
        expect(await readFile(join(src, "setup.txt"), "utf-8")).toBe("first fail\n");
        expect(project.run("setup", [])).rejects.toThrow('The script "setup" takes (name: string), not 0 arguments.');
        expect(project.run("nope")).rejects.toThrow('The script "nope" is not built: run build first, or check the name. The scripts built are default, setup.');
    });
});
