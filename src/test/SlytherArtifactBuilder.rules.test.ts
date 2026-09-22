import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherArtifactBuilder } from "../src/classes/SlytherArtifactBuilder.class.ts";
import { SlytherArtifactKind } from "../src/classes/SlytherArtifactKind.class.ts";
import { SlytherGenerator } from "../src/classes/SlytherGenerator.class.ts";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

/** Replies with the sh script registered for every path, the next one on every fix, and keeps what it was told. */
class FakeGenerator extends SlytherGenerator {
    readonly asked: string[] = [];
    readonly fixed: string[] = [];
    readonly prompts: Record<string, string> = {};

    constructor(readonly scripts: Record<string, string | string[]>) {
        super();
    }

    override async ask<T>(prompt: string, _schema: object, session?: string): Promise<{ result: T; session: string }> {
        const path = (/`([^`]+)` in sh/.exec(prompt) ?? /`([^`]+)`\.$/m.exec(prompt))![1]!;
        const registered = this.scripts[path];
        const content = Array.isArray(registered) ? (registered.length > 1 ? registered.shift()! : registered[0]!) : registered;

        (session ? this.fixed : this.asked).push(path);
        this.prompts[path] = session ? `${this.prompts[path]}\n--fix--\n${prompt}` : prompt;

        return { result: { files: [{ path, content: `${content}\n` }], dependencies: {} } as T, session: "s" };
    }

    override async execute(prompt: string): Promise<{ text: string; session: string }> {
        return { text: `executed:${prompt}`, session: "e" };
    }
}

const ARTIFACTS = ".slyther/artifacts";
/** The check of a rule receives segments: it fails when any of the files holds BAD. */
const CHECK = 'for s in "$@"; do f="${s%%:*}"; grep -q BAD "$f" && echo "has BAD in $s" && exit 1; done; exit 0';
const SCRIPTS = {
    "k/locate/locate.sh": '[ -f "src/$1.txt" ] && echo "src/$1.txt" && exit 0; exit 1',
    "k/list/list.sh": "exit 0",
    "k/evaluate/Errors.no-bad.sh": CHECK,
    "k/evaluate/k.short.sh": 'for s in "$@"; do f="${s%%:*}"; [ "$(wc -l < "$f")" -gt 3 ] && echo "too long" && exit 1; done; exit 0',
    "k/create/scaffold.sh": "touch src/$1.txt",
};
const SPEC = (trait = "", rules = "rule short: deterministic { at most three lines }", create = "") => `@lang "sh"
@trait Errors {
    Failures are typed.
    rule no-bad: deterministic { never holds the word BAD }
    rule holds-bad: negative {
        Breaks #{Errors::no-bad}.
        \`\`\`txt
        this is BAD
        \`\`\`
    }
    ${trait}
}
@artifact k (content: string) {
    guidance of k
    rule #{Errors}
    ${rules}
    operation locate: deterministic { prints src/{id}.txt }
    operation create {
        deterministic scaffold { ${create || "makes the file"} }
        llm fill { fills the file }
    }
}`;

let root = "";
const kindsOf = (spec: string) => SlytherArtifactKind.of(new SlytherParser().parse(new SlytherScript(spec)));
const build = (generator: FakeGenerator, spec = SPEC(), attempts?: number) => new SlytherArtifactBuilder(root, ARTIFACTS, generator, { attempts }).build(kindsOf(spec));
const read = (path: string) => readFile(join(root, ARTIFACTS, path), "utf-8");
const manifest = async () => JSON.parse(await read("manifest.json"));

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "slyther-builder-rules-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("SlytherArtifactBuilder rules", () => {
    test("builds the check of every rule as a step of evaluate, named after the rule, and records the rule on the step", async () => {
        const generator = new FakeGenerator(SCRIPTS);
        const report = await build(generator);

        expect(report.map((entry) => `${entry.status} ${entry.path}`)).toEqual([
            "built k/locate/locate.sh",
            "built k/list/list.sh",
            "built k/create/scaffold.sh",
            "built k/create/fill.md",
            "built k/create/operation.md",
            "built k/evaluate/Errors.no-bad.sh",
            "built k/evaluate/k.short.sh",
        ]);

        const recorded = await manifest();

        expect(recorded.operations["k::evaluate"].deterministic).toBe(true);
        expect(recorded.operations["k::evaluate"].steps).toEqual([
            { name: "Errors.no-bad", kind: "deterministic", path: "k/evaluate/Errors.no-bad.sh", lang: "sh", run: ["sh", ".slyther/artifacts/k/evaluate/Errors.no-bad.sh"], role: "scribe", rule: "Errors::no-bad" },
            { name: "k.short", kind: "deterministic", path: "k/evaluate/k.short.sh", lang: "sh", run: ["sh", ".slyther/artifacts/k/evaluate/k.short.sh"], role: "scribe", rule: "k::short" },
        ]);

        const prompt = generator.prompts["k/evaluate/Errors.no-bad.sh"]!;

        expect(prompt).toContain('the check of the rule "Errors::no-bad" for every artifact of the kind "k"');
        expect(prompt).toContain("## The trait Errors\n\nFailures are typed.");
        expect(prompt).toContain("## Rule Errors::no-bad\n\nnever holds the word BAD");
        expect(prompt).toContain("### Errors::holds-bad");
        expect(prompt).toContain("<segment>...");
        expect(prompt).not.toContain("guidance of k");
        expect(generator.prompts["k/evaluate/k.short.sh"]).toContain("## Every k\n\nguidance of k");
    });

    test("a writer is shown the guidance, every rule and every negative; a script is shown only the rules it references", async () => {
        const generator = new FakeGenerator(SCRIPTS);

        await build(generator, SPEC("", "rule short: deterministic { at most three lines }", "makes the file as #{k::short} says"));

        const fill = await read("k/create/fill.md");

        expect(fill).toContain("guidance of k");
        expect(fill).toContain("### Trait Errors");
        expect(fill).toContain("### Rule Errors::no-bad (checked by a script)");
        expect(fill).toContain("#### Never, as Errors::holds-bad");
        expect(fill).toContain("### Rule k::short (checked by a script)");

        const scaffold = generator.prompts["k/create/scaffold.sh"]!;

        expect(scaffold).toContain("guidance of k");
        expect(scaffold).toContain("### Rule k::short\n\nat most three lines");
        expect(scaffold).not.toContain("no-bad");

        const locate = generator.prompts["k/locate/locate.sh"]!;

        expect(locate).toContain("guidance of k");
        expect(locate).not.toContain("no-bad");
    });

    test("the check of a rule is shown what an asset it references copies", async () => {
        await mkdir(join(root, "scaffolding"), { recursive: true });
        await writeFile(join(root, "scaffolding/env.ts"), "export const Environment = { Port: env!.PORT };\n");

        const spec = `asset shape ref "scaffolding/env.ts" to "src/env.ts"\n${SPEC("", "rule short: deterministic { follows the shape of #{shape} }")}`;
        const parsed = new SlytherParser().parse(new SlytherScript(spec, join(root, "main.sly")), root);
        const generator = new FakeGenerator(SCRIPTS);

        await new SlytherArtifactBuilder(root, ARTIFACTS, generator).build(SlytherArtifactKind.of(parsed), [], parsed);

        expect(generator.prompts["k/evaluate/k.short.sh"]).toContain("export const Environment = { Port: env!.PORT };");
    });

    test("editing a rule rebuilds its check and what is shown every rule, never what only reads an instance", async () => {
        await build(new FakeGenerator(SCRIPTS));

        const report = await build(new FakeGenerator(SCRIPTS), SPEC("", "rule short: deterministic { at most two lines }"));

        expect(report.map((entry) => `${entry.status} ${entry.path}`)).toEqual([
            "kept k/locate/locate.sh",
            "kept k/list/list.sh",
            "rebuilt k/create/scaffold.sh",
            "rebuilt k/create/fill.md",
            "rebuilt k/create/operation.md",
            "kept k/evaluate/Errors.no-bad.sh",
            "rebuilt k/evaluate/k.short.sh",
        ]);

        const referencing = SPEC("", "rule short: deterministic { at most two lines }", "makes the file as #{k::short} says");

        await build(new FakeGenerator(SCRIPTS), referencing);

        const again = await build(new FakeGenerator(SCRIPTS), referencing.replace("never holds the word BAD", "never ever holds the word BAD"));

        expect(again.map((entry) => `${entry.status} ${entry.path}`)).toEqual([
            "kept k/locate/locate.sh",
            "kept k/list/list.sh",
            "kept k/create/scaffold.sh",
            "rebuilt k/create/fill.md",
            "rebuilt k/create/operation.md",
            "rebuilt k/evaluate/Errors.no-bad.sh",
            "kept k/evaluate/k.short.sh",
        ]);
    });

    test("a check that accepts a negative is sent back to be fixed, saying which one, and the negative is cleaned up", async () => {
        const generator = new FakeGenerator({ ...SCRIPTS, "k/evaluate/Errors.no-bad.sh": ["exit 0", CHECK] });
        const report = await build(generator);

        expect(report.find((entry) => entry.path === "k/evaluate/Errors.no-bad.sh")!.status).toBe("built");
        expect(generator.fixed).toEqual(["k/evaluate/Errors.no-bad.sh"]);
        expect(generator.prompts["k/evaluate/Errors.no-bad.sh"]).toContain(
            '.slyther/artifacts/k/evaluate/Errors.no-bad.sh accepts "Errors::holds-bad", which breaks the rule "Errors::no-bad": it must exit 1 for a file holding:\nthis is BAD',
        );
        expect(await readFile(join(root, ARTIFACTS, ".negatives"), "utf-8").catch(() => "gone")).toBe("gone");
    });

    test("a negative may name the file it is, so a check that looks for that name finds it", async () => {
        const spec = SPEC().replace("```txt\n        this is BAD", "```txt bad/index.txt\n        this is BAD");
        const named = 'for s in "$@"; do case "$s" in */index.txt) grep -q BAD "$s" && echo "has BAD in $s" && exit 1;; esac; done; exit 0';
        const generator = new FakeGenerator({ ...SCRIPTS, "k/evaluate/Errors.no-bad.sh": ["exit 0", named] });

        await build(generator, spec);

        expect(generator.fixed).toEqual(["k/evaluate/Errors.no-bad.sh"]);
        expect(generator.prompts["k/evaluate/Errors.no-bad.sh"]).toContain('accepts "Errors::holds-bad"');
    });

    test("a check that keeps accepting a negative fails the build", async () => {
        const generator = new FakeGenerator({ ...SCRIPTS, "k/evaluate/Errors.no-bad.sh": "exit 0" });

        await expect(build(generator, SPEC(), 2)).rejects.toThrow('k/evaluate/Errors.no-bad.sh failed verification 2 times');
    });
});
