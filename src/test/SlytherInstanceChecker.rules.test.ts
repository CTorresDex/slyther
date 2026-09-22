import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherGenerator } from "../src/classes/SlytherGenerator.class.ts";
import { SlytherProject } from "../src/classes/SlytherProject.class.ts";

/** Builds the sh scripts registered for every path, judges every llm rule as told, and mends on execute. */
class FakeGenerator extends SlytherGenerator {
    readonly judged: string[] = [];
    readonly executed: string[] = [];

    constructor(
        readonly scripts: Record<string, string>,
        readonly verdict: { pass: boolean; errors: string[] } = { pass: true, errors: [] },
        readonly mend: () => Promise<void> = async () => {},
    ) {
        super();
    }

    override async ask<T>(prompt: string): Promise<{ result: T; session: string }> {
        if (prompt.includes("Reply with `pass`")) {
            this.judged.push(prompt);

            return { result: this.verdict as T, session: "s" };
        }

        const path = /`([^`]+)` in sh/.exec(prompt)![1]!;

        return { result: { files: [{ path, content: `${this.scripts[path]}\n` }], dependencies: {} } as T, session: "s" };
    }

    override async execute(prompt: string): Promise<{ text: string; session: string }> {
        this.executed.push(prompt);
        await this.mend();

        return { text: "", session: `e${this.executed.length}` };
    }
}

/** Every check of a rule receives segments, reads only the lines of a range, and marks that it ran, so a test can count the runs. */
const CHECK = (word: string, version = "") =>
    [
        `echo "${word}" >> src/ran`,
        'for s in "$@"; do f="${s%%:*}"; r="${s#*:}"',
        'if [ "$r" = "$s" ]; then text=$(cat "$f"); else text=$(sed -n "${r%%-*},${r#*-}p" "$f"); fi',
        `echo "$text" | grep -q ${word} && echo "holds ${word} in $s" && exit 1`,
        `done; exit 0 ${version}`,
    ].join("; ");
const SCRIPTS = {
    "k/locate/locate.sh": '[ -f "src/$1.txt" ] || exit 1; if [ -f "src/$1.range" ]; then echo "src/$1.txt:$(cat src/$1.range)"; else echo "src/$1.txt"; fi',
    "k/list/list.sh": 'ls src/*.txt 2>/dev/null | sed "s|src/||; s|\\.txt$||"',
    "k/evaluate/k.no-bad.sh": CHECK("BAD"),
    "k/evaluate/k.no-ugly.sh": CHECK("UGLY"),
    "k/update/fix.sh": 'sed -i "" "s/BAD/GOOD/; s/UGLY/FINE/" "src/$1.txt"',
};
const SPEC = (rules = "rule no-bad: deterministic { never BAD }\n rule no-ugly: deterministic { never UGLY }", guidance = "rules of k") => `@lang "sh"
@artifact k (requirements: string?) {
    ${guidance}
    ${rules}
    operation locate: deterministic { prints src/{id}.txt }
    operation update (id, errors): deterministic {
        deterministic fix { replaces BAD }
    }
}
k A { the a }`;

let root = "";
const code = () => join(root, SlytherProject.OUTPUT, SlytherProject.SOURCE, "src");
const write = (name: string, content: string) => writeFile(join(code(), name), content);
const read = (name: string) => readFile(join(code(), name), "utf-8").catch(() => "");
const project = (generator = new FakeGenerator(SCRIPTS)) => new SlytherProject(root, generator);
const compile = async (generator?: FakeGenerator) => (await project(generator).build()).instances;
const statuses = (report: { key: string; status: string; reason?: string }[]) => report.map((entry) => `${entry.key} ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}`);
const manifest = async () => JSON.parse(await readFile(join(root, ".slyther/instances/manifest.json"), "utf-8"));
const ran = async () => (await read("ran")).split("\n").filter((line) => line.length > 0);

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "slyther-checker-rules-"));
    await mkdir(code(), { recursive: true });
    await writeFile(join(root, "main.sly"), SPEC());
    await write("A.txt", "a\n");
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("SlytherInstanceChecker rules", () => {
    test("the check of a rule is run with the segments locate printed, and its errors are named after the rule", async () => {
        await write("A.txt", "fine\nBAD here\n");
        await write("A.range", "1-1");

        expect(statuses(await project().check())).toEqual(["k:A pass (never evaluated)"]);

        await rm(join(code(), "A.range"));
        await write("A.txt", "fine\nBAD here\nUGLY too\n");

        const report = await project().check();

        expect(statuses(report)).toEqual(["k:A fail (its code changed)"]);
        expect(report[0]!.errors).toEqual(["k::no-bad: holds BAD in src/A.txt", "k::no-ugly: holds UGLY in src/A.txt"]);

        const recorded = (await manifest()).instances["k:A"];

        expect(recorded.checks["k.no-bad"]).toMatchObject({ pass: false, errors: ["k::no-bad: holds BAD in src/A.txt"] });
        expect(recorded.checks["k.no-ugly"].pass).toBe(false);
        expect(recorded.checks["k.no-bad"].hash).toMatch(/^[0-9a-f]{64}$/);
        expect((await manifest()).version).toBe(4);
    });

    test("editing one rule runs that check alone, and updates only what fails it", async () => {
        await write("A.txt", "fine\n");
        await compile();
        await write("ran", "");
        await writeFile(join(root, "main.sly"), SPEC("rule no-bad: deterministic { never BAD }\n rule no-ugly: deterministic { never ever UGLY }"));

        // The check written for the edited rule is lenient: it looks for another word entirely.
        const lenient = new FakeGenerator({ ...SCRIPTS, "k/evaluate/k.no-ugly.sh": CHECK("NOPE") });

        expect(statuses(await compile(lenient))).toEqual(["k:A pass (what evaluates it changed: k.no-ugly)"]);
        expect(await ran()).toEqual(["NOPE"]);
        expect(lenient.executed).toEqual([]);

        await write("A.txt", "UGLY\n");

        expect(statuses(await project().check())).toEqual(["k:A pass (its code changed)"]);

        await write("ran", "");
        await writeFile(join(root, "main.sly"), SPEC("rule no-bad: deterministic { never BAD }\n rule no-ugly: deterministic { never UGLY at all }"));

        const report = await compile();

        expect(statuses(report)).toEqual(["k:A fixed (what evaluates it changed: k.no-ugly)"]);
        expect(await ran()).toEqual(["UGLY", "BAD", "UGLY"]);
        expect(await read("A.txt")).toBe("FINE\n");
    });

    test("removing a rule drops its verdict without running anything", async () => {
        await write("A.txt", "UGLY\n");

        expect(statuses(await project().check())).toEqual(["k:A fail (never evaluated)"]);

        await writeFile(join(root, "main.sly"), SPEC("rule no-bad: deterministic { never BAD }"));
        await write("ran", "");

        const report = await project().check();

        expect(statuses(report)).toEqual(["k:A pass (what evaluates it changed: k.no-ugly removed)"]);
        expect(report[0]!.errors).toEqual([]);
        expect(await ran()).toEqual([]);
        expect(Object.keys((await manifest()).instances["k:A"].checks)).toEqual(["k.no-bad"]);
    });

    test("editing the guidance updates every instance first, as a rule change does not", async () => {
        await write("A.txt", "fine\n");
        await compile();
        await writeFile(join(root, "main.sly"), SPEC(undefined, "the stricter rules of k"));

        expect(statuses(await compile())).toEqual(["k:A updated (the rules of its kind changed)"]);
    });

    test("a manifest of version 3 runs every check once and updates nothing that passes", async () => {
        await write("A.txt", "fine\n");
        await compile();

        const path = join(root, ".slyther/instances/manifest.json");
        const written = await manifest();

        for (const record of Object.values(written.instances) as { checks?: unknown }[]) delete record.checks;

        await writeFile(path, JSON.stringify({ version: 3, instances: written.instances }, null, 4));
        await write("ran", "");

        const generator = new FakeGenerator(SCRIPTS);

        expect(statuses(await compile(generator))).toEqual(["k:A pass (what evaluates it changed: k.no-bad, k.no-ugly)"]);
        expect(await ran()).toEqual(["BAD", "UGLY"]);
        expect(generator.executed).toEqual([]);
        expect((await manifest()).version).toBe(4);
        expect(statuses(await compile())).toEqual(["k:A kept"]);
    });

    test("the check of a rule finds the args of the instance in its environment", async () => {
        await writeFile(join(root, "main.sly"), `${SPEC('rule named: deterministic { holds its id }')}\nk B (requirements: "must") { the b }`);
        await write("A.txt", "A\n");
        await write("B.txt", "B must\n");

        const check = 'for s in "$@"; do grep -q "$SLYTHER_ID" "$s" || { echo "no $SLYTHER_ID"; exit 1; }; grep -q "${SLYTHER_REQUIREMENTS:-}" "$s" || { echo "no $SLYTHER_REQUIREMENTS"; exit 1; }; done; exit 0';
        const generator = new FakeGenerator({ ...SCRIPTS, "k/evaluate/k.named.sh": check });

        expect(statuses(await project(generator).check())).toEqual(["k:A pass (never evaluated)", "k:B pass (never evaluated)"]);

        await write("B.txt", "B\n");

        const report = await project(generator).check();

        expect(statuses(report)).toEqual(["k:A kept", "k:B fail (its code changed)"]);
        expect(report[1]!.errors).toEqual(["k::named: no must"]);
    });

    test("an llm rule is judged on its own, and its errors are named after it", async () => {
        await writeFile(join(root, "main.sly"), SPEC("rule no-bad: deterministic { never BAD }\n rule tidy { reads well }"));

        const generator = new FakeGenerator(SCRIPTS, { pass: false, errors: ["it rambles"] });
        const report = await project(generator).check();

        expect(statuses(report)).toEqual(["k:A fail (never evaluated)"]);
        expect(report[0]!.errors).toEqual(["k::tidy: it rambles"]);
        expect(generator.judged).toHaveLength(1);
        expect(generator.judged[0]).toContain('complies with the rule "k::tidy", and with that rule alone');
        expect(generator.judged[0]).toContain("## Rule k::tidy\n\nreads well");
        expect(generator.judged[0]).toContain("### Its code");
    });
});
