import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherGenerator } from "../src/classes/SlytherGenerator.class.ts";
import { SlytherProject } from "../src/classes/SlytherProject.class.ts";

/** Builds the sh scripts registered for every path, and answers every llm evaluation as told. */
class FakeGenerator extends SlytherGenerator {
    readonly evaluated: string[] = [];
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
};
const SPEC = (evaluate = "operation evaluate (id: string): deterministic {\n deterministic check { fails on BAD }\n }") => `@lang "sh"
@artifact k {
    rules of k
    operation locate (id: string): deterministic { prints src/{id}.txt }
    ${evaluate}
    operation update (id: string, errors: string): deterministic {
        deterministic fix { replaces BAD }
    }
}
k A { the a }
k B { uses #{A} }`;

let root = "";
const write = (name: string, content: string) => writeFile(join(root, "src", name), content);
const project = (generator = new FakeGenerator(SCRIPTS)) => new SlytherProject(root, generator);
const statuses = (report: { key: string; status: string; reason?: string }[]) =>
    report.map((entry) => `${entry.key} ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}`);
const manifest = async () => JSON.parse(await readFile(join(root, ".slyther/instances/manifest.json"), "utf-8")).instances;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "slyther-checker-"));
    await mkdir(join(root, "src"));
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
        await mkdir(join(root, "src", "D"));
        await write("D/one.txt", "1\n");

        expect(statuses(await project().check())).toContain("k:D pass (never evaluated)");
        expect((await manifest())["k:D"].contentHash).toBe((await manifest())["k:D"].contentHash);

        await write("D/one.txt", "changed\n");

        expect(statuses(await project().check())).toContain("k:D kept");

        await mkdir(join(root, "src", "D", "sub"));

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

        await rm(join(root, "src", "B.txt"));
        await write("C.txt", "c\n");

        const report = await new SlytherProject(root, new FakeGenerator(SCRIPTS), (line) => lines.push(line)).check();

        expect(statuses(report)).toEqual(["k:A pass (never evaluated)", "k:B missing"]);
        expect(lines).toContain('warning: the k "C" exists but is not declared');
    });

    test("an instance that fails is reported with its errors, and fixed with --fix", async () => {
        await write("B.txt", "BAD\n");

        const failed = await project().check();

        expect(statuses(failed)).toEqual(["k:A pass (never evaluated)", "k:B fail (never evaluated)"]);
        expect(failed[1]!.errors).toEqual(["has BAD"]);

        const fixed = await project().check({ fix: true });

        expect(statuses(fixed)).toEqual(["k:A kept", "k:B fixed (it failed last time)"]);
        expect(await readFile(join(root, "src", "B.txt"), "utf-8")).toBe("GOOD\n");
        expect(statuses(await project().check())).toEqual(["k:A kept", "k:B kept"]);
    });

    test("evaluates with the llm when evaluate has an llm step, and refuses more than --max", async () => {
        await writeFile(join(root, "main.sly"), SPEC("operation evaluate (id: string) {\n llm verify { judge it }\n }"));

        const generator = new FakeGenerator(SCRIPTS, { pass: false, errors: ["not good"] });

        expect(project(generator).check({ max: 1 })).rejects.toThrow("2 instances need an evaluation with the llm, more than the 1 allowed");

        const report = await project(generator).check();

        expect(generator.evaluated).toEqual(["A", "B"]);
        expect(report.map((entry) => entry.errors)).toEqual([["not good"], ["not good"]]);
    });
});
