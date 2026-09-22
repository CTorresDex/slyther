import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherGenerator } from "../src/classes/SlytherGenerator.class.ts";
import { SlytherProject } from "../src/classes/SlytherProject.class.ts";
import { SlytherProviders } from "../src/classes/SlytherProviders.class.ts";
import { SlytherRole } from "../src/classes/SlytherRole.class.ts";

/**
 * Builds the sh scripts registered for every path, answers every llm evaluation as told, and, when
 * asked to execute, runs `mend` with how many times it was asked so a test can stand in for what the
 * llm writes. Every execute opens session `e<n>`, and records the session it was told to resume.
 */
class FakeGenerator extends SlytherGenerator {
    readonly evaluated: string[] = [];
    readonly prompts: string[] = [];
    readonly executed: string[] = [];
    readonly resumed: (string | undefined)[] = [];

    constructor(
        readonly scripts: Record<string, string>,
        readonly verdict: { pass: boolean; errors: string[] } = { pass: true, errors: [] },
        readonly mend: (round: number) => Promise<void> = async () => {},
    ) {
        super();
    }

    override async ask<T>(prompt: string): Promise<{ result: T; session: string }> {
        if (prompt.includes("Reply with `pass`")) {
            this.evaluated.push(/to evaluate: (\S+)/.exec(prompt)![1]!);
            this.prompts.push(prompt);

            return { result: this.verdict as T, session: "s" };
        }

        const path = /`([^`]+)`\.$/m.exec(prompt)![1]!;

        return { result: { files: [{ path, content: `${this.scripts[path]}\n` }], dependencies: {} } as T, session: "s" };
    }

    override async execute(prompt: string, _cwd: string, session?: string): Promise<{ text: string; session: string }> {
        this.executed.push(prompt);
        this.resumed.push(session);
        await this.mend(this.executed.length);

        return { text: "", session: `e${this.executed.length}` };
    }
}

/** Every instance is `src/<id>.txt`; its signature is the lines of `src/<id>.sig`, what it uses the lines of `src/<id>.uses`. */
const SCRIPTS = {
    "k/locate/locate.sh": '[ -d "src/$1" ] && echo "src/$1/" && exit 0; [ -f "src/$1.txt" ] || exit 1; if [ -f "src/$1.range" ]; then echo "src/$1.txt:$(cat src/$1.range)"; else echo "src/$1.txt"; fi',
    "k/list/list.sh": 'ls src/*.txt 2>/dev/null | sed "s|src/||; s|\\.txt$||"',
    "k/signature/signature.sh": '[ -f "src/$1.sig" ] || exit 1; cat "src/$1.sig"',
    "k/uses/uses.sh": '[ -f "src/$1.txt" ] || exit 1; [ -f "src/$1.uses" ] && cat "src/$1.uses"; exit 0',
    "k/evaluate/check.sh": 'grep -q BAD "src/$1.txt" && echo "has BAD" && exit 1; exit 0',
    "k/update/fix.sh": 'sed -i "" "s/BAD/GOOD/" "src/$1.txt"',
    "k/create/make.sh": 'printf "%s\\n" "$2" > "src/$1.txt"',
};
const SPEC = (evaluate = "operation evaluate (id): deterministic {\n deterministic check { fails on BAD }\n }") => `@lang "sh"
@artifact k (requirements: string, kind: string?) {
    rules of k
    operation locate: deterministic { prints src/{id}.txt }
    ${evaluate}
    operation update (id, errors): deterministic {
        deterministic fix { replaces BAD }
    }
    operation create (id, requirements): deterministic {
        deterministic make { writes the requirements }
    }
}
k A { the a }
k B { uses #{A} }`;

let root = "";
/** Where the code lives: the project runs everything from .slyther/src, and every instance is under its src. */
const code = () => join(root, SlytherProject.OUTPUT, SlytherProject.SOURCE, "src");
const write = (name: string, content: string) => writeFile(join(code(), name), content);
const read = (name: string) => readFile(join(code(), name), "utf-8");
const project = (generator = new FakeGenerator(SCRIPTS)) => new SlytherProject(root, generator);
const compile = async (generator?: FakeGenerator) => (await project(generator).build()).instances;
const statuses = (report: { key: string; status: string; reason?: string }[]) =>
    report.map((entry) => `${entry.key} ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}`);
const manifest = async () => JSON.parse(await readFile(join(root, ".slyther/instances/manifest.json"), "utf-8")).instances;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "slyther-checker-"));
    await mkdir(code(), { recursive: true });
    await writeFile(join(root, "main.sly"), SPEC());
    await write("A.txt", "a\n");
    await write("A.sig", "name string\ngreet (): string\n");
    await write("B.txt", "b\n");
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("SlytherInstanceChecker", () => {
    test("evaluates every instance the first time, dependencies first, and records what it saw", async () => {
        const report = await project().check();

        expect(statuses(report)).toEqual(["k:A pass (never evaluated)", "k:B pass (never evaluated)"]);

        const recorded = await manifest();

        expect(recorded["k:A"].signature).toEqual(["name string", "greet (): string"]);
        expect(recorded["k:B"].dependencies["k:A"].signature).toEqual(["name string", "greet (): string"]);
        expect(recorded["k:B"].result).toBe("pass");
        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B kept"]);
    });

    test("evaluates an instance again when its code changes, and not its dependents when its signature does not", async () => {
        await project().check();
        await write("A.txt", "a changed\n");

        expect(statuses(await project().check())).toEqual(["k:A pass (its code changed)", "k:B kept"]);
    });

    test("a segment that is a folder is its listing, not the content of its files", async () => {
        await writeFile(join(root, "main.sly"), `${SPEC()}\nk D { a folder }`);
        await mkdir(join(code(), "D"));
        await write("D/one.txt", "1\n");

        expect(statuses(await project().check())).toContain("k:D pass (never evaluated)");
        expect((await manifest())["k:D"].contentHash).toBe((await manifest())["k:D"].contentHash);

        await write("D/one.txt", "changed\n");

        expect(statuses(await project().check())).toContain("k:D kept");

        await mkdir(join(code(), "D", "sub"));

        expect(statuses(await project().check())).toContain("k:D pass (its code changed)");
    });

    test("ignores where a segment is, only what it holds", async () => {
        await write("A.range", "1-1");
        await project().check();
        await write("A.txt", "a\nmore\n");

        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B kept"]);
    });

    test("evaluates a dependent again when a key it uses changes, and not when another does", async () => {
        await write("B.uses", "k:A greet\n");
        await project().check();
        await write("A.sig", "name number\ngreet (): string\n");

        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B kept"]);

        await write("A.sig", "name number\ngreet (): number\n");

        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B pass (uses greet of k:A, which changed)"]);
    });

    test("without uses, a dependent follows every existing key but not the added ones", async () => {
        await project().check();
        await write("A.sig", "name string\ngreet (): string\nemail string\n");

        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B kept"]);

        await write("A.sig", "greet (): string\nemail string\n");

        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B pass (k:A, which it uses, changed name)"]);
    });

    test("with **, a dependent follows the added keys too", async () => {
        await write("B.uses", "k:A **\n");
        await project().check();
        await write("A.sig", "name string\ngreet (): string\nemail string\n");

        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B pass (k:A, which it depends on entirely, changed)"]);
    });

    test("a dependent that uses a key that is gone fails without being evaluated", async () => {
        await write("B.uses", "k:A name\n");
        await project().check();
        await write("A.sig", "greet (): string\n");

        const report = await project().check();

        expect(statuses(report)).toEqual(["k:A kept", "k:B fail (uses name of k:A, which no longer exists)"]);
        expect(report[1]!.errors).toEqual(["uses name of k:A, which no longer exists"]);
        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B fail (uses name of k:A, which no longer exists)"]);
    });

    test("an instance that is declared but not found is missing, and one found but not declared is a warning", async () => {
        const lines: string[] = [];

        await rm(join(code(), "B.txt"));
        await write("C.txt", "c\n");

        const report = await new SlytherProject(root, new FakeGenerator(SCRIPTS), { log: (line) => lines.push(line), say: () => {} }).check();

        expect(statuses(report)).toEqual(["k:A pass (never evaluated)", "k:B missing"]);
        expect(lines).toContain('warning: the k "C" exists but is not declared');
    });

    test("an instance that fails is reported with its errors by check, and fixed by build", async () => {
        await write("B.txt", "BAD\n");

        const failed = await project().check();

        expect(statuses(failed)).toEqual(["k:A pass (never evaluated)", "k:B fail (never evaluated)"]);
        expect(failed[1]!.errors).toEqual(["has BAD"]);
        expect(await read("B.txt")).toBe("BAD\n");
        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B fail (unchanged since it failed)"]);

        const fixed = await compile();

        expect(statuses(fixed)).toEqual(["k:A kept", "k:B updated (it failed its last evaluation)"]);
        expect(await read("B.txt")).toBe("GOOD\n");
        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B kept"]);
    });

    test("a locate that prints a segment that is not there fails its instance, and the build goes on", async () => {
        const broken = { ...SCRIPTS, "k/locate/locate.sh": '[ -f "src/$1.txt" ] || exit 1; if [ "$1" = "B" ]; then echo "src/gone.txt"; else echo "src/$1.txt"; fi' };
        const report = await compile(new FakeGenerator(broken));
        const error = 'the locate of k printed "src/gone.txt", which does not exist: it must print a path, `path:start-end` for a range of lines, or `path:line` for one.';

        expect(statuses(report)).toEqual(["k:A pass (never evaluated)", `k:B fail (${error})`]);
        expect(report[1]!.errors).toEqual([error]);
        expect(await read("B.txt")).toBe("b\n");
    });

    test("a segment of one line is that line, and it changes only with it", async () => {
        await write("B.txt", "one\ntwo\nthree\n");
        await write("B.range", "2");
        await project().check();
        await write("B.txt", "one\ntwo\nCHANGED\n");

        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B kept"]);

        await write("B.txt", "one\nTWO\nCHANGED\n");

        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B pass (its code changed)"]);
    });

    test("build creates a missing instance from its declaration, and check only reports it", async () => {
        await rm(join(code(), "B.txt"));

        expect(statuses(await project().check())).toEqual(["k:A pass (never evaluated)", "k:B missing"]);

        const created = await compile();

        expect(statuses(created)).toEqual(["k:A kept", "k:B created (missing)"]);
        expect(await read("B.txt")).toBe("uses #{A}\n");
        expect((await manifest())["k:B"].result).toBe("pass");
        expect(statuses(await compile())).toEqual(["k:A kept", "k:B kept"]);
    });

    test("build updates an instance whose declaration changed, and check only evaluates it", async () => {
        await write("B.txt", "BAD\n");
        await compile();
        await writeFile(join(root, "main.sly"), SPEC().replace("k B { uses #{A} }", "k B { uses #{A} differently }"));

        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B pass (its spec changed)"]);
        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B pass (its spec changed)"]);
        expect(statuses(await compile())).toEqual(["k:A kept", "k:B updated (its spec changed)"]);
        expect(statuses(await compile())).toEqual(["k:A kept", "k:B kept"]);
    });

    test("a created instance that fails evaluation is updated with the errors, and one that cannot be created stays missing", async () => {
        await rm(join(code(), "B.txt"));
        await writeFile(join(root, "main.sly"), SPEC().replace("k B { uses #{A} }", "k B { BAD at first }"));

        expect(statuses(await compile())).toEqual(["k:A pass (never evaluated)", "k:B created (missing)"]);
        expect(await read("B.txt")).toBe("GOOD at first\n");

        await rm(join(code(), "B.txt"));
        await writeFile(join(root, "main.sly"), SPEC().replace("    operation create (id, requirements): deterministic {\n        deterministic make { writes the requirements }\n    }\n", "").replace("k B { uses #{A} }", "k B { BAD at first }"));

        expect(statuses(await compile())).toEqual(["k:A kept", "k:B missing"]);
    });

    test("create throws when a param gets nothing from the declaration", async () => {
        await rm(join(code(), "B.txt"));
        await writeFile(join(root, "main.sly"), SPEC().replace("k B { uses #{A} }", "k B"));

        expect(compile()).rejects.toThrow('k:B gives nothing for the param "requirements" of k::create');
    });

    test("the llm evaluates against the declaration of the instance", async () => {
        await writeFile(join(root, "main.sly"), SPEC("operation evaluate (id) {\n llm verify { judge it }\n }").replace("k A { the a }", 'k A (kind: "helper") { the a }'));

        const generator = new FakeGenerator(SCRIPTS);

        await project(generator).check();

        expect(generator.prompts[0]).toContain("### What it must do\n\n- kind: helper\n\nthe a\n\n### Its code\n\n#### src/A.txt");
    });

    test("evaluates with the llm when evaluate has an llm step, and refuses more than --max", async () => {
        await writeFile(join(root, "main.sly"), SPEC("operation evaluate (id) {\n llm verify { judge it }\n }"));

        const generator = new FakeGenerator(SCRIPTS, { pass: false, errors: ["not good"] });

        expect(project(generator).check({ max: 1 })).rejects.toThrow("2 instances need the llm, more than the 1 allowed");

        const report = await project(generator).check();

        expect(generator.evaluated).toEqual(["A", "B"]);
        expect(report.map((entry) => entry.errors)).toEqual([["not good"], ["not good"]]);
    });
});

describe("SlytherInstanceChecker brings what changed in line", () => {
    /** An update that marks the file instead of fixing it, so running it is visible even when evaluate passes. */
    const MARKING = { ...SCRIPTS, "k/update/fix.sh": 'printf "updated\\n" >> "src/$1.txt"' };

    test("the rules of a kind that change update every instance of it, though its evaluate passes", async () => {
        await compile();

        await writeFile(join(root, "main.sly"), SPEC().replace("rules of k", "the stricter rules of k"));

        expect(statuses(await compile(new FakeGenerator(MARKING)))).toEqual([
            "k:A updated (the rules of its kind changed)",
            "k:B updated (the rules of its kind changed)",
        ]);
        expect(await read("A.txt")).toBe("a\nupdated\n");
        expect(statuses(await compile())).toEqual(["k:A kept", "k:B kept"]);
    });

    test("check reports the rules that changed without touching the code, and a later build still updates it", async () => {
        await compile();
        await writeFile(join(root, "main.sly"), SPEC().replace("rules of k", "the stricter rules of k"));

        expect(statuses(await project().check())).toEqual([
            "k:A pass (the rules of its kind changed)",
            "k:B pass (the rules of its kind changed)",
        ]);
        expect(await read("A.txt")).toBe("a\n");
        expect(statuses(await compile(new FakeGenerator(MARKING)))).toEqual([
            "k:A updated (the rules of its kind changed)",
            "k:B updated (the rules of its kind changed)",
        ]);
    });

    test("what evaluates it that changes evaluates every instance first, and updates only the ones that fail", async () => {
        const strict = { ...MARKING, "k/evaluate/strict.sh": 'grep -qx b "src/$1.txt" && ! grep -q updated "src/$1.txt" && echo "plain b" && exit 1; exit 0' };

        await compile(new FakeGenerator(strict));
        await writeFile(join(root, "main.sly"), SPEC("operation evaluate (id): deterministic {\n deterministic check { fails on BAD }\n deterministic strict { fails on a plain b }\n }"));

        expect(statuses(await compile(new FakeGenerator(strict)))).toEqual([
            "k:A pass (what evaluates it changed: strict)",
            "k:B fixed (what evaluates it changed: strict)",
        ]);
        expect(await read("A.txt")).toBe("a\n");
        expect(await read("B.txt")).toBe("b\nupdated\n");
        expect(statuses(await compile(new FakeGenerator(strict)))).toEqual(["k:A kept", "k:B kept"]);
    });

    test("every step of evaluate runs, so a failure reports the errors of all of them", async () => {
        const loud = { ...SCRIPTS, "k/evaluate/loud.sh": 'grep -q BAD "src/$1.txt" && echo "too loud" && exit 1; exit 0' };

        await writeFile(join(root, "main.sly"), SPEC("operation evaluate (id): deterministic {\n deterministic check { fails on BAD }\n deterministic loud { fails on BAD too }\n }"));
        await write("B.txt", "BAD\n");

        const report = await project(new FakeGenerator(loud)).check();

        expect(statuses(report)).toEqual(["k:A pass (never evaluated)", "k:B fail (never evaluated)"]);
        expect(report[1]!.errors).toEqual(["has BAD", "too loud"]);
    });

    test("an update that rewrites what evaluates it has it put back, and fails", async () => {
        const cheat = { ...SCRIPTS, "k/update/fix.sh": 'echo "exit 0" > ../artifacts/k/evaluate/check.sh' };
        const judge = () => readFile(join(root, ".slyther/artifacts/k/evaluate/check.sh"), "utf-8");

        await compile(new FakeGenerator(cheat));

        const original = await judge();

        await write("B.txt", "BAD\n");

        const report = await compile(new FakeGenerator(cheat));

        expect(statuses(report)).toEqual(["k:A kept", "k:B fail (its code changed)"]);
        expect(report[1]!.errors).toEqual(["has BAD"]);
        expect(await judge()).toBe(original);
    });

    test("code edited by hand is brought back in line with the prose, not merely evaluated", async () => {
        await compile(new FakeGenerator(MARKING));
        await write("B.txt", "edited by hand\n");

        expect(statuses(await compile(new FakeGenerator(MARKING)))).toEqual(["k:A kept", "k:B updated (its code changed)"]);
        expect(await read("B.txt")).toBe("edited by hand\nupdated\n");
    });

    test("a reference that changes updates what depends on it, rather than trusting its evaluate", async () => {
        await compile(new FakeGenerator(MARKING));
        await write("A.txt", "a changed\n");
        await write("A.sig", "name string\n");

        expect(statuses(await compile(new FakeGenerator(MARKING)))).toEqual([
            "k:A updated (its code changed)",
            "k:B updated (k:A, which it uses, changed greet)",
        ]);
    });

    test("an instance with no record yet is evaluated as it stands, and never updated", async () => {
        expect(statuses(await compile(new FakeGenerator(MARKING)))).toEqual(["k:A pass (never evaluated)", "k:B pass (never evaluated)"]);
        expect(await read("A.txt")).toBe("a\n");
    });

    test("a manifest written before the rules were recorded is brought forward without updating anything", async () => {
        await compile(new FakeGenerator(MARKING));

        const path = join(root, ".slyther/instances/manifest.json");
        const read1 = JSON.parse(await readFile(path, "utf-8"));

        for (const record of Object.values(read1.instances) as { rulesHash?: string }[]) delete record.rulesHash;

        await writeFile(path, JSON.stringify({ instances: read1.instances }, null, 4));

        expect(statuses(await compile(new FakeGenerator(MARKING)))).toEqual(["k:A kept", "k:B kept"]);

        const read2 = JSON.parse(await readFile(path, "utf-8"));

        expect(read2.version).toBe(4);
        expect(read2.instances["k:A"].rulesHash).toMatch(/^[0-9a-f]{64}$/);

        await writeFile(join(root, "main.sly"), SPEC().replace("rules of k", "the stricter rules of k"));

        expect(statuses(await compile(new FakeGenerator(MARKING)))).toEqual([
            "k:A updated (the rules of its kind changed)",
            "k:B updated (the rules of its kind changed)",
        ]);
    });
});

describe("SlytherInstanceChecker references", () => {
    const LLM = "operation evaluate (id) {\n llm verify { judge it }\n }";
    const RULE = "\n@artifact rule\nrule R { be nice }";

    test("the llm receives what the instance references: the rules of a kind, the prose of a plain artifact, and an instance with its signature", async () => {
        await writeFile(join(root, "main.sly"), `${SPEC(LLM)}${RULE}`.replace("k B { uses #{A} }", "k B { uses #{A}, follows #{R}, is a #{k} }"));

        const generator = new FakeGenerator(SCRIPTS);

        await project(generator).check();

        const prompt = generator.prompts[1]!;

        expect(prompt).toContain("### What it references\n\n#### The rules of every k\n\nrules of k\n\n#### k A\n\nthe a\n\nSignature:\n\n- name string\n- greet (): string\n\n#### rule R\n\nbe nice\n\nReply with");
        expect(generator.prompts[0]).not.toContain("What it references");
    });

    test("an llm create receives what the instance references", async () => {
        await rm(join(code(), "B.txt"));
        await writeFile(
            join(root, "main.sly"),
            SPEC().replace("    operation create (id, requirements): deterministic {\n        deterministic make { writes the requirements }\n    }\n", "    operation create (id, requirements) {\n        llm write { writes it }\n    }\n"),
        );

        const generator = new FakeGenerator(SCRIPTS);

        await compile(generator);

        expect(generator.executed[0]).toContain("## What it references\n\n### k A\n\nthe a\n\nSignature:\n\n- name string\n- greet (): string");
    });

    test("an llm create is told which instance it is run on, with the value of every param", async () => {
        await rm(join(code(), "B.txt"));
        await writeFile(
            join(root, "main.sly"),
            SPEC().replace("    operation create (id, requirements): deterministic {\n        deterministic make { writes the requirements }\n    }\n", "    operation create (id, requirements) {\n        llm write { writes it }\n    }\n"),
        );

        const generator = new FakeGenerator(SCRIPTS);

        await compile(generator);

        expect(generator.executed[0]).toContain("## The k to create: B\n\n### Its params\n\n- id: B\n- requirements: uses #{A}\n\n### What it must do\n\nuses #{A}");
    });

    test("an llm update is told which instance it is run on, and the errors stay in their own section", async () => {
        await writeFile(
            join(root, "main.sly"),
            SPEC().replace("    operation update (id, errors): deterministic {\n        deterministic fix { replaces BAD }\n    }\n", "    operation update (id, errors) {\n        llm mend { mends it }\n    }\n"),
        );
        await compile();
        await write("B.txt", "edited by hand\n");

        const generator = new FakeGenerator(SCRIPTS);

        await compile(generator);

        expect(generator.executed[0]).toContain("## The k to update: B\n\n### Its params\n\n- id: B\n\n### What it must do\n\nuses #{A}");
        expect(generator.executed[0]).not.toContain("- errors:");
    });

    const MENDING = '    operation update (id, errors) {\n        llm mend { mends it }\n    }\n';
    const mending = (spec: string) =>
        spec.replace("    operation update (id, errors): deterministic {\n        deterministic fix { replaces BAD }\n    }\n", MENDING);

    test("an llm update is told what changed in the declaration, as a diff against what it was last brought in line with", async () => {
        await writeFile(join(root, "main.sly"), mending(SPEC()));
        await compile();
        await writeFile(join(root, "main.sly"), mending(SPEC()).replace("k B { uses #{A} }", "k B { uses #{A} and shouts }"));

        const generator = new FakeGenerator(SCRIPTS);

        await compile(generator);

        expect(generator.executed[0]).toContain("## Why it is being updated\n\nits spec changed\n");
        expect(generator.executed[0]).toContain("### What changed in what it must do\n\n```diff\n- uses #{A}\n+ uses #{A} and shouts\n```");
        expect(generator.executed[0]).toContain("the code is what is wrong, never the prose");
    });

    test("an llm update is told what changed in the rules of its kind", async () => {
        await writeFile(join(root, "main.sly"), mending(SPEC()));
        await compile();
        await writeFile(join(root, "main.sly"), mending(SPEC()).replace("rules of k", "the stricter rules of k"));

        const generator = new FakeGenerator(SCRIPTS);

        await compile(generator);

        expect(generator.executed[0]).toContain("## Why it is being updated\n\nthe rules of its kind changed\n");
        expect(generator.executed[0]).toContain("### What changed in the rules of every k\n\n```diff\n- rules of k\n+ the stricter rules of k\n```");
        expect(generator.executed[0]).not.toContain("What changed in what it must do");
    });

    test("an llm update told nothing changed in the prose carries the reason and no diff", async () => {
        await writeFile(join(root, "main.sly"), mending(SPEC()));
        await compile();
        await write("B.txt", "edited by hand\n");

        const generator = new FakeGenerator(SCRIPTS);

        await compile(generator);

        expect(generator.executed[0]).toContain("## Why it is being updated\n\nits code changed\n");
        expect(generator.executed[0]).not.toContain("```diff");
    });

    test("the declaration recorded covers what the instance leans on, so a diff shows what changed there", async () => {
        const spec = mending(`${SPEC()}${RULE}`).replace("k B { uses #{A} }", "k B { follows #{R} }");

        await writeFile(join(root, "main.sly"), spec);
        await compile();
        await writeFile(join(root, "main.sly"), spec.replace("be nice", "be kind"));

        const generator = new FakeGenerator(SCRIPTS);

        await compile(generator);

        expect(generator.executed[0]).toContain("```diff\n  follows #{R}\n  \n  (leans on rule R)\n- be nice\n+ be kind\n```");
    });

    test("editing what an instance leans on counts as a change of its spec", async () => {
        const spec = `${SPEC()}${RULE}`.replace("k B { uses #{A} }", "k B { follows #{R} and is a #{k} }");

        await writeFile(join(root, "main.sly"), spec);
        await compile();
        await writeFile(join(root, "main.sly"), spec.replace("be nice", "be kind"));

        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B pass (its spec changed)"]);
        expect(statuses(await compile())).toEqual(["k:A kept", "k:B updated (its spec changed)"]);

        await writeFile(join(root, "main.sly"), spec.replace("be nice", "be kind").replace("rules of k", "the rules of k"));

        // B leans on the kind, so its spec changed; A is brought in line because the rules it follows did.
        expect(statuses(await compile())).toEqual(["k:A updated (the rules of its kind changed)", "k:B updated (its spec changed)"]);
        expect(statuses(await compile())).toEqual(["k:A kept", "k:B kept"]);
    });
});

describe("SlytherInstanceChecker composite", () => {
    const COMPOSITE = (parts = "one two", prose = "the p") => `${SPEC()}
@artifact c (parts: string) {
    a composite
    operation expand: deterministic { prints a #{k} per part }
}
c P (parts: "${parts}") { ${prose} }`;
    const EXPAND = { ...SCRIPTS, "c/expand/expand.sh": 'for part in $2; do echo "k $part { the $part }"; done' };
    const expanded = () => readFile(join(root, ".slyther/instances/expanded/c/P.sly"), "utf-8");

    test("an instance of a composite kind is expanded, and what it emits is created and checked under it", async () => {
        await writeFile(join(root, "main.sly"), COMPOSITE());

        const report = await compile(new FakeGenerator(EXPAND));

        expect(statuses(report)).toEqual([
            "c:P expanded (emitted 2 instances)",
            "k:P::one created (missing)",
            "k:P::two created (missing)",
            "k:A pass (never evaluated)",
            "k:B pass (never evaluated)",
        ]);
        expect(report.slice(1, 3).map((entry) => entry.parent)).toEqual(["c:P", "c:P"]);
        expect(await read("P::one.txt")).toBe("the one\n");
        expect(await expanded()).toBe("k one { the one }\nk two { the two }\n");

        const recorded = await manifest();

        expect(recorded["k:P::one"].parent).toBe("c:P");
        expect(recorded["c:P"].result).toBe("pass");
        expect(statuses(await compile(new FakeGenerator(EXPAND)))).toEqual(["c:P expanded (emitted 2 instances)", "k:P::one kept", "k:P::two kept", "k:A kept", "k:B kept"]);
    });

    test("editing the prose of the parent updates what it emitted", async () => {
        await writeFile(join(root, "main.sly"), COMPOSITE());
        await compile(new FakeGenerator(EXPAND));
        await writeFile(join(root, "main.sly"), COMPOSITE("one two", "the p, changed"));

        expect(statuses(await project(new FakeGenerator(EXPAND)).check())).toEqual([
            "c:P expanded (emitted 2 instances)",
            "k:P::one pass (its spec changed)",
            "k:P::two pass (its spec changed)",
            "k:A kept",
            "k:B kept",
        ]);
        expect(statuses(await compile(new FakeGenerator(EXPAND)))).toEqual([
            "c:P expanded (emitted 2 instances)",
            "k:P::one updated (its spec changed)",
            "k:P::two updated (its spec changed)",
            "k:A kept",
            "k:B kept",
        ]);
    });

    test("what the parent no longer emits is an orphan, left alone and reported until its code is gone", async () => {
        await writeFile(join(root, "main.sly"), COMPOSITE());
        await compile(new FakeGenerator(EXPAND));
        await writeFile(join(root, "main.sly"), COMPOSITE("one"));

        const report = await compile(new FakeGenerator(EXPAND));

        expect(statuses(report)).toEqual([
            "c:P expanded (emitted 1 instance)",
            "k:P::one updated (its spec changed)",
            "k:P::two orphan (no longer emitted by c:P)",
            "k:A kept",
            "k:B kept",
        ]);
        expect(await read("P::two.txt")).toBe("the two\n");
        expect((await manifest())["k:P::two"].result).toBe("orphan");
        expect(await expanded()).toBe("k one { the one }\n");

        await rm(join(code(), "P::two.txt"));

        expect(statuses(await compile(new FakeGenerator(EXPAND)))).toEqual(["c:P expanded (emitted 1 instance)", "k:P::one kept", "k:A kept", "k:B kept"]);
        expect((await manifest())["k:P::two"]).toBeUndefined();
    });

    test("when what it emits is not valid, the parent fails with the reason and nothing is created", async () => {
        await writeFile(join(root, "main.sly"), `${COMPOSITE()}\n@artifact plain\nplain X { x }`);

        const generator = new FakeGenerator({ ...EXPAND, "c/expand/expand.sh": 'if [ "$1" = sample ]; then echo "k one { ok }"; else echo "plain one { nope }"; fi' });
        const report = await compile(generator);

        expect(statuses(report)).toEqual(["c:P fail (what it emitted is not valid)", "k:A pass (never evaluated)", "k:B pass (never evaluated)"]);
        expect(report[0]!.errors).toEqual(['c:P emitted the plain "P::one", but its expand does not reference plain: it may only emit k.']);
        expect(await stat(join(code(), "P::one.txt")).then(() => true, () => false)).toBe(false);
    });
});

describe("SlytherInstanceChecker params of the kind", () => {
    /** A kind whose operations name no params, so each is run with everything the kind declares. */
    const EVERY = `@lang "sh"
@artifact w (requirements: string, tone: string?) {
    rules of w
    operation locate: deterministic { prints src/{id}.txt }
    operation evaluate: deterministic { accepts anything }
    operation create: deterministic {
        deterministic write { writes every param it is given }
    }
}
w One (tone: "loud") { the one }
w Two { the two }`;
    const EVERY_SCRIPTS = {
        ...SCRIPTS,
        "w/locate/locate.sh": '[ -f "src/$1.txt" ] || exit 1; echo "src/$1.txt"',
        "w/list/list.sh": "true",
        "w/evaluate/evaluate.sh": "exit 0",
        "w/create/write.sh": 'printf "%s|%s\\n" "$2" "$3" > "src/$1.txt"',
    };

    test("an operation that names no params is run with every param of its kind, and an optional one the instance omits is empty", async () => {
        await writeFile(join(root, "main.sly"), EVERY);
        await project(new FakeGenerator(EVERY_SCRIPTS)).build();

        expect(await read("One.txt")).toBe("the one|loud\n");
        expect(await read("Two.txt")).toBe("the two|\n");
    });
});

describe("SlytherInstanceChecker locate with params", () => {
    /** A kind whose id does not say where its instances are: the path is an arg of the instance. */
    const AT = (path = "src/docs/a.md") => `${SPEC()}
@artifact p (path: string, requirements: string) {
    rules of p
    operation locate (id, path): deterministic { prints the path }
    operation evaluate (id, path): deterministic { accepts anything }
    operation create (id, path, requirements): deterministic {
        deterministic write { writes the requirements at the path }
    }
}
p Doc (path: "${path}") { a doc }`;
    const AT_SCRIPTS = {
        ...SCRIPTS,
        "p/locate/locate.sh": '[ -f "$2" ] || exit 1; echo "$2"',
        "p/list/list.sh": "true",
        "p/evaluate/evaluate.sh": "exit 0",
        "p/create/write.sh": 'mkdir -p "$(dirname "$2")"; printf "%s\\n" "$3" > "$2"',
    };
    const at = () => new FakeGenerator(AT_SCRIPTS);

    test("locate is run with the args of the instance, and what found it is recorded", async () => {
        await writeFile(join(root, "main.sly"), AT());

        expect(statuses(await compile(at()))).toContain("p:Doc created (missing)");
        expect(await readFile(join(code(), "docs/a.md"), "utf-8")).toBe("a doc\n");
        expect((await manifest())["p:Doc"].locatedWith).toEqual(["Doc", "src/docs/a.md"]);
        expect(statuses(await compile(at()))).toContain("p:Doc kept");
    });

    test("the code an instance moves away from is reported as an orphan, once, and left alone", async () => {
        await writeFile(join(root, "main.sly"), AT());
        await compile(at());
        await writeFile(join(root, "main.sly"), AT("src/docs/b.md"));

        const report = await compile(at());

        expect(statuses(report)).toContain("p:Doc orphan (moved, so its code is left at src/docs/a.md)");
        expect(statuses(report)).toContain("p:Doc created (missing)");
        expect(await readFile(join(code(), "docs/a.md"), "utf-8")).toBe("a doc\n");
        expect(await readFile(join(code(), "docs/b.md"), "utf-8")).toBe("a doc\n");
        expect((await manifest())["p:Doc"].locatedWith).toEqual(["Doc", "src/docs/b.md"]);

        const again = await compile(at());

        expect(statuses(again)).toContain("p:Doc kept");
        expect(statuses(again).some((status) => status.includes("orphan"))).toBe(false);
    });
});

describe("SlytherInstanceChecker fixes", () => {
    const MENDING = "    operation update (id, errors) {\n        llm mend { mends it }\n    }\n";
    const mending = (spec: string) =>
        spec.replace("    operation update (id, errors): deterministic {\n        deterministic fix { replaces BAD }\n    }\n", MENDING);
    const CREATING = "    operation create (id, requirements) {\n        llm write { writes it }\n    }\n";
    const creating = (spec: string) =>
        spec.replace("    operation create (id, requirements): deterministic {\n        deterministic make { writes the requirements }\n    }\n", CREATING);
    const build = (generator: FakeGenerator, options: { fixes?: number } = {}, lines: string[] = []) =>
        new SlytherProject(root, generator, { log: (line) => lines.push(line), say: () => {} }).build(options);

    test("fixes a failing instance on the second round, resuming the session of the round before", async () => {
        await writeFile(join(root, "main.sly"), mending(SPEC()));
        await write("B.txt", "BAD\n");

        const generator = new FakeGenerator(SCRIPTS, { pass: true, errors: [] }, async (round) => write("B.txt", round === 1 ? "STILL BAD\n" : "GOOD\n"));
        const { instances } = await build(generator);

        expect(statuses(instances)).toEqual(["k:A pass (never evaluated)", "k:B fixed (never evaluated)"]);
        expect(generator.executed).toHaveLength(2);
        expect(generator.resumed).toEqual([undefined, "e1"]);
        expect(generator.executed[1]).toContain("## Why it failed evaluation\n\n- has BAD\n");
        expect(await read("B.txt")).toBe("GOOD\n");
        expect((await manifest())["k:B"].result).toBe("pass");
    });

    test("stops without evaluating again when the update changed nothing", async () => {
        await writeFile(join(root, "main.sly"), mending(SPEC()));
        await write("B.txt", "BAD\n");

        const lines: string[] = [];
        const generator = new FakeGenerator(SCRIPTS);
        const { instances } = await build(generator, {}, lines);

        expect(statuses(instances)).toEqual(["k:A pass (never evaluated)", "k:B fail (never evaluated)"]);
        expect(instances[1]!.errors).toEqual(["has BAD"]);
        expect(generator.executed).toHaveLength(1);
        expect(lines).toContain("k:B: the update changed nothing, so it is not evaluated again");
        expect(lines.some((line) => line.startsWith("k:B: failed evaluation, updating to fix (1 of 2):"))).toBe(true);
    });

    test("leaves an instance failing with the errors of its last evaluation once the fixes run out", async () => {
        await writeFile(join(root, "main.sly"), mending(SPEC()));
        await write("B.txt", "BAD\n");

        const generator = new FakeGenerator(SCRIPTS, { pass: true, errors: [] }, async (round) => write("B.txt", `BAD ${round}\n`));
        const { instances } = await build(generator);

        expect(statuses(instances)).toEqual(["k:A pass (never evaluated)", "k:B fail (never evaluated)"]);
        expect(instances[1]!.errors).toEqual(["has BAD"]);
        expect(generator.executed).toHaveLength(2);
        expect(generator.resumed).toEqual([undefined, "e1"]);
        expect(await read("B.txt")).toBe("BAD 2\n");
    });

    test("with fixes 0 a failing instance is never updated", async () => {
        await writeFile(join(root, "main.sly"), mending(SPEC()));
        await write("B.txt", "BAD\n");

        const generator = new FakeGenerator(SCRIPTS, { pass: true, errors: [] }, async () => write("B.txt", "GOOD\n"));
        const { instances } = await build(generator, { fixes: 0 });

        expect(statuses(instances)).toEqual(["k:A pass (never evaluated)", "k:B fail (never evaluated)"]);
        expect(generator.executed).toHaveLength(0);
        expect(await read("B.txt")).toBe("BAD\n");
    });

    test("a fix of an instance the llm created resumes the session of the create", async () => {
        await writeFile(join(root, "main.sly"), mending(creating(SPEC())));
        await rm(join(code(), "B.txt"));

        const generator = new FakeGenerator(SCRIPTS, { pass: true, errors: [] }, async (round) => write("B.txt", round === 1 ? "BAD\n" : "GOOD\n"));
        const { instances } = await build(generator);

        expect(instances.find((entry) => entry.key === "k:B")!.status).toBe("created");
        expect(generator.executed).toHaveLength(2);
        expect(generator.resumed).toEqual([undefined, "e1"]);
        expect(generator.executed[0]).toContain("## The k to create: B");
        expect(generator.executed[1]).toContain("## The k to update: B");
        expect(await read("B.txt")).toBe("GOOD\n");
    });
});

describe("SlytherInstanceChecker roles", () => {
    /** Records who every call was asked of: the scripts it writes and the verdicts it gives. */
    class CastingGenerator extends FakeGenerator {
        readonly casts: string[] = [];

        override async ask<T>(prompt: string, _schema?: object, _session?: string, cast?: SlytherRole["cast"]): Promise<{ result: T; session: string }> {
            this.casts.push(`${prompt.includes("Reply with `pass`") ? "judged" : "wrote"} by ${cast ? SlytherRole.fingerprintOf(cast) : "no one"}`);

            return super.ask<T>(prompt);
        }
    }

    const LLM = "operation evaluate (id) {\n llm verify { judge it }\n }";
    const ROLES = (writer: string, judge: string) => `@role engineer "claude-cli" (model: "${writer}")\n@role reviewer "claude-cli" (model: "${judge}")\n`;
    const staff = (writer: string, judge: string, evaluate = LLM) => writeFile(join(root, "main.sly"), ROLES(writer, judge) + SPEC(evaluate));

    test("every call is asked of whoever plays its role: the scribe writes the scripts, the reviewer judges", async () => {
        await staff("w1", "j1");

        const generator = new CastingGenerator(SCRIPTS);

        await compile(generator);

        expect(new Set(generator.casts)).toEqual(
            new Set(["wrote by scribe=engineer@claude-cli(model=w1)", "judged by reviewer=reviewer@claude-cli(model=j1)"]),
        );
    });

    test("who judges is part of what evaluates an instance, and who writes is not", async () => {
        await staff("w1", "j1");
        await compile(new CastingGenerator(SCRIPTS));

        await staff("w2", "j1");
        expect(statuses(await compile(new CastingGenerator(SCRIPTS)))).toEqual(["k:A kept", "k:B kept"]);

        await staff("w2", "j2");

        const generator = new CastingGenerator(SCRIPTS);

        expect(statuses(await compile(generator))).toEqual(["k:A pass (what evaluates it changed: verify)", "k:B pass (what evaluates it changed: verify)"]);
        expect(generator.casts).toContain("judged by reviewer=reviewer@claude-cli(model=j2)");
    });

    test("a role nobody binds is played by the standard one of its line, and the build says so", async () => {
        await staff("w1", "j1", 'operation evaluate (id) {\n llm verify (by: "auditor") { judge it }\n }');

        const lines: string[] = [];
        const generator = new CastingGenerator(SCRIPTS);

        await new SlytherProject(root, generator, { log: (line) => lines.push(line), say: () => {} }).build();

        expect(lines).toContain("warning: nobody plays the auditor, so the reviewer does: bind it with @role auditor to choose who does.");
        expect(generator.casts).toContain("judged by auditor=reviewer@claude-cli(model=j1)");
    });

    test("an alias is pinned for the whole build to what it resolves to, and what it judged is evaluated again once that changes", async () => {
        /** Resolves "newest" to whatever model it is told is the newest now. */
        class ResolvingGenerator extends CastingGenerator {
            constructor(private readonly newest: string) {
                super(SCRIPTS);
            }

            override async pin(options: Record<string, string>): Promise<Record<string, string>> {
                return options.model === "newest" ? { ...options, model: this.newest } : options;
            }

            override async pinRoles(roles: Map<string, SlytherRole["binding"]>, named: string[]): Promise<Map<string, SlytherRole["binding"]>> {
                return new Map(await Promise.all([...roles].map(async ([role, binding]) => [role, named.includes(role) ? { ...binding, options: await this.pin(binding.options) } : binding] as const)));
            }
        }

        const build = async (newest: string) => {
            const lines: string[] = [];
            const generator = new ResolvingGenerator(newest);
            const report = await new SlytherProject(root, generator, { log: (line) => lines.push(line), say: () => {} }).build();

            return { lines, generator, statuses: statuses(report.instances) };
        };

        await staff("w1", "newest");

        const first = await build("m5");

        expect(first.lines).toContain('reviewer: "newest" resolves to m5');
        expect(first.generator.casts).toContain("judged by reviewer=reviewer@claude-cli(model=m5)");
        expect((await build("m5")).statuses).toEqual(["k:A kept", "k:B kept"]);

        const moved = await build("m6");

        expect(moved.lines).toContain('reviewer: "newest" now resolves to m6, no longer m5, so what it judged is evaluated again');
        expect(moved.statuses).toEqual(["k:A pass (what evaluates it changed: verify)", "k:B pass (what evaluates it changed: verify)"]);
    });

    test("a project whose roles nobody plays is refused before anything is built or asked", async () => {
        await writeFile(join(root, "main.sly"), SPEC(LLM));

        await expect(new SlytherProject(root, new SlytherProviders()).build()).rejects.toThrow(
            'Nobody plays the scribe, nor the engineer who would stand in for it: bind it with @role engineer "<provider>" (model: "<model id>"). The providers are claude-cli.',
        );
        expect(await stat(join(root, ".slyther/artifacts/manifest.json")).then(() => true, () => false)).toBe(false);
    });
});
