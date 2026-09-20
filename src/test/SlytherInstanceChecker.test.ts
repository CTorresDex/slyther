import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherGenerator } from "../src/classes/SlytherGenerator.class.ts";
import { SlytherProject } from "../src/classes/SlytherProject.class.ts";

/** Builds the sh scripts registered for every path, and answers every llm evaluation as told. */
class FakeGenerator extends SlytherGenerator {
    readonly evaluated: string[] = [];
    readonly prompts: string[] = [];
    readonly executed: string[] = [];

    constructor(
        readonly scripts: Record<string, string>,
        readonly verdict: { pass: boolean; errors: string[] } = { pass: true, errors: [] },
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

    override async execute(prompt: string): Promise<string> {
        this.executed.push(prompt);

        return "";
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
const SPEC = (evaluate = "operation evaluate (id: string): deterministic {\n deterministic check { fails on BAD }\n }") => `@lang "sh"
@artifact k {
    rules of k
    operation locate (id: string): deterministic { prints src/{id}.txt }
    ${evaluate}
    operation update (id: string, errors: string): deterministic {
        deterministic fix { replaces BAD }
    }
    operation create (id: string, requirements: string): deterministic {
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
        await writeFile(join(root, "main.sly"), SPEC().replace("    operation create (id: string, requirements: string): deterministic {\n        deterministic make { writes the requirements }\n    }\n", "").replace("k B { uses #{A} }", "k B { BAD at first }"));

        expect(statuses(await compile())).toEqual(["k:A kept", "k:B missing"]);
    });

    test("create throws when a param gets nothing from the declaration", async () => {
        await rm(join(code(), "B.txt"));
        await writeFile(join(root, "main.sly"), SPEC().replace("k B { uses #{A} }", "k B"));

        expect(compile()).rejects.toThrow('k:B gives nothing for the param "requirements" of k::create');
    });

    test("the llm evaluates against the declaration of the instance", async () => {
        await writeFile(join(root, "main.sly"), SPEC("operation evaluate (id: string) {\n llm verify { judge it }\n }").replace("k A { the a }", 'k A (kind: "helper") { the a }'));

        const generator = new FakeGenerator(SCRIPTS);

        await project(generator).check();

        expect(generator.prompts[0]).toContain("### What it must do\n\n- kind: helper\n\nthe a\n\n### Its code\n\n#### src/A.txt");
    });

    test("evaluates with the llm when evaluate has an llm step, and refuses more than --max", async () => {
        await writeFile(join(root, "main.sly"), SPEC("operation evaluate (id: string) {\n llm verify { judge it }\n }"));

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

        expect(read2.version).toBe(3);
        expect(read2.instances["k:A"].rulesHash).toMatch(/^[0-9a-f]{64}$/);

        await writeFile(join(root, "main.sly"), SPEC().replace("rules of k", "the stricter rules of k"));

        expect(statuses(await compile(new FakeGenerator(MARKING)))).toEqual([
            "k:A updated (the rules of its kind changed)",
            "k:B updated (the rules of its kind changed)",
        ]);
    });
});

describe("SlytherInstanceChecker references", () => {
    const LLM = "operation evaluate (id: string) {\n llm verify { judge it }\n }";
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
            SPEC().replace("    operation create (id: string, requirements: string): deterministic {\n        deterministic make { writes the requirements }\n    }\n", "    operation create (id: string, requirements: string) {\n        llm write { writes it }\n    }\n"),
        );

        const generator = new FakeGenerator(SCRIPTS);

        await compile(generator);

        expect(generator.executed[0]).toContain("## What it references\n\n### k A\n\nthe a\n\nSignature:\n\n- name string\n- greet (): string");
    });

    test("an llm create is told which instance it is run on, with the value of every param", async () => {
        await rm(join(code(), "B.txt"));
        await writeFile(
            join(root, "main.sly"),
            SPEC().replace("    operation create (id: string, requirements: string): deterministic {\n        deterministic make { writes the requirements }\n    }\n", "    operation create (id: string, requirements: string) {\n        llm write { writes it }\n    }\n"),
        );

        const generator = new FakeGenerator(SCRIPTS);

        await compile(generator);

        expect(generator.executed[0]).toContain("## The k to create: B\n\n### Its params\n\n- id: B\n- requirements: uses #{A}\n\n### What it must do\n\nuses #{A}");
    });

    test("an llm update is told which instance it is run on, and the errors stay in their own section", async () => {
        await writeFile(
            join(root, "main.sly"),
            SPEC().replace("    operation update (id: string, errors: string): deterministic {\n        deterministic fix { replaces BAD }\n    }\n", "    operation update (id: string, errors: string) {\n        llm mend { mends it }\n    }\n"),
        );
        await compile();
        await write("B.txt", "edited by hand\n");

        const generator = new FakeGenerator(SCRIPTS);

        await compile(generator);

        expect(generator.executed[0]).toContain("## The k to update: B\n\n### Its params\n\n- id: B\n\n### What it must do\n\nuses #{A}");
        expect(generator.executed[0]).not.toContain("- errors:");
    });

    const MENDING = '    operation update (id: string, errors: string) {\n        llm mend { mends it }\n    }\n';
    const mending = (spec: string) =>
        spec.replace("    operation update (id: string, errors: string): deterministic {\n        deterministic fix { replaces BAD }\n    }\n", MENDING);

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
@artifact c {
    a composite
    operation expand (id: string, parts: string): deterministic { prints a #{k} per part }
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

describe("SlytherInstanceChecker locate with params", () => {
    /** A kind whose id does not say where its instances are: the path is an arg of the instance. */
    const AT = (path = "src/docs/a.md") => `${SPEC()}
@artifact p {
    rules of p
    operation locate (id: string, path: string): deterministic { prints the path }
    operation evaluate (id: string, path: string): deterministic { accepts anything }
    operation create (id: string, path: string, requirements: string): deterministic {
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
