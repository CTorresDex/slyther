import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

const parse = (source: string) => new SlytherParser().parse(new SlytherScript(source));
const find = (source: string, name: string) => parse(source).artifacts.find((artifact) => artifact.name === name)!;

describe("SlytherParser qualifiers", () => {
    test("reads the qualifiers written after the colon, in order", () => {
        const artifact = find("@artifact k {\n operation locate: deterministic { x }\n}", "k::locate");

        expect(artifact.qualifiers).toEqual(["deterministic"]);
        expect(artifact.content).toBe("x");
    });

    test("reads the qualifiers after the args", () => {
        const artifact = find('@artifact k {\n operation locate (lang: "ts"): deterministic { x }\n}', "k::locate");

        expect(artifact.args).toEqual([{ name: "lang", kind: "string", value: "ts" }]);
        expect(artifact.qualifiers).toEqual(["deterministic"]);
    });

    test("throws when a qualifier is written twice", () => {
        expect(() => parse("@artifact k {\n operation locate: deterministic, deterministic { x }\n}")).toThrow(
            'Qualifier "deterministic" is written twice on "k::locate".',
        );
    });

    test("the qualifiers change the hash", () => {
        const plain = find("@artifact k {\n operation locate { x }\n}", "k::locate");
        const qualified = find("@artifact k {\n operation locate: deterministic { x }\n}", "k::locate");

        expect(plain.hash).not.toBe(qualified.hash);
    });

    test("a prose line with a colon is still prose", () => {
        const kind = find("@artifact k {\n Note foo: bar, baz\n Prints a: b {\n }\n}", "k");

        expect(kind.content).toBe("Note foo: bar, baz\nPrints a: b {\n}");
    });

    test("a step block without a name throws, unless escaped as prose", () => {
        expect(() => parse("@artifact k {\n operation create (id: string) {\n  llm {\n   do it\n  }\n }\n}\n")).toThrow(
            'The llm block inside operation "k::create" needs a name, as in "llm setup {".',
        );
        expect(parse("@artifact k {\n operation create (id: string) {\n  \\llm { do it }\n }\n}\n").artifacts.find((a) => a.name === "k::create")!.content).toContain("llm { do it }");
    });
});

describe("SlytherParser artifact args", () => {
    test("a kind takes its params in the first parens and its configuration in the second", () => {
        expect(find('@artifact k (a: string, b: number?) (lang: "ts") { rules }', "k").args).toEqual([
            { name: "a", kind: "type", value: "string" },
            { name: "b", kind: "type", value: "number", optional: true },
            { name: "lang", kind: "string", value: "ts" },
        ]);
    });

    test("a single parens holds either, decided by what it writes", () => {
        expect(find('@artifact k (lang: "ts") { rules }', "k").args).toEqual([{ name: "lang", kind: "string", value: "ts" }]);
        expect(find("@artifact k (a: string) { rules }", "k").args).toEqual([{ name: "a", kind: "type", value: "string" }]);
    });

    test("throws when the parens are mixed up", () => {
        expect(() => parse('@artifact k (a: string, lang: "ts") { rules }')).toThrow(
            'The kind "k" declared with @artifact takes its params and its configuration in separate parens.',
        );
        expect(() => parse('@artifact k (lang: "ts") (a: string) { rules }')).toThrow(
            'The kind "k" declared with @artifact takes its params in the first parens and its configuration in the second.',
        );
    });

    test("a kind may declare its params and still take its prose from a file", async () => {
        const folder = await mkdtemp(join(tmpdir(), "slyther-args-"));

        await writeFile(join(folder, "rules.md"), "the rules");

        const kind = new SlytherParser().parse(new SlytherScript('@artifact k (a: string) ref "./rules.md"', join(folder, "main.sly")), folder).artifacts[0]!;

        expect(kind.args).toEqual([{ name: "a", kind: "type", value: "string" }]);
        expect(kind.source?.mode).toBe("ref");

        await rm(folder, { recursive: true, force: true });
    });

    test("a bare name is a param an operation narrows to, and only an operation may write one", () => {
        expect(find("@artifact k {\n operation create (id, a) { x }\n}", "k::create").args).toEqual([
            { name: "id", kind: "param", value: "" },
            { name: "a", kind: "param", value: "" },
        ]);
        expect(() => parse("@artifact k (a) { rules }")).toThrow(
            'Argument "a" of "k" has no value: only an operation writes a bare name, to narrow to the params of its kind.',
        );
        expect(() => parse("@artifact k {\n operation create {\n  deterministic go (a) { x }\n }\n}")).toThrow(
            'Argument "a" of "k::create::go" has no value: only an operation writes a bare name, to narrow to the params of its kind.',
        );
    });
});

describe("SlytherParser extend", () => {
    const script = "@artifact k\nk P { the p }";
    const parent = () => find(script, "P");

    test("reads declarations under the parent, referencing it and each other", () => {
        const { parsed, added } = new SlytherParser().extend(parse(script), parent(), "k one { uses #{two} }\nk two { the two }\n");

        expect(added.map((artifact) => `${artifact.artifact}:${artifact.name}`)).toEqual(["k:P::one", "k:P::two"]);
        expect(added[0]!.references).toEqual(["k:P", "k:P::two"]);
        expect(added[1]!.references).toEqual(["k:P"]);
        expect(added[1]!.content).toBe("the two");
        expect(parsed.artifacts).toHaveLength(4);
        expect(parsed.closureHashes.has("k:P::one")).toBe(true);
    });

    test("throws on a directive, on prose outside a block and on a nested block", () => {
        const parser = new SlytherParser();

        expect(() => parser.extend(parse(script), parent(), '@lang "ts"\n')).toThrow('"@lang "ts"" is not a declaration.');
        expect(() => parser.extend(parse(script), parent(), "hello\n")).toThrow('"hello" is not a declaration.');
        expect(() => parser.extend(parse(script), parent(), "hello there\n")).toThrow('Unknown artifact "hello" of "P::there".');
        expect(() => parser.extend(parse(script), parent(), "k one {\n operation x { y }\n}\n")).toThrow('"operation" cannot be declared inside k "P::one".');
    });

    test("throws on an unknown kind, an unknown reference and a name already declared", () => {
        const parser = new SlytherParser();

        expect(() => parser.extend(parse(script), parent(), "x one { y }")).toThrow('Unknown artifact "x" of "P::one".');
        expect(() => parser.extend(parse(script), parent(), "k one { uses #{nothing} }")).toThrow('Unknown reference "nothing".');
        expect(() => parser.extend(parse(`${script}\nk P::one { by hand }`), parent(), "k one { again }")).toThrow('Duplicate declaration "P::one".');
    });
});

describe("SlytherParser from and ref", () => {
    let dir = "";
    const at = (source: string, base?: string) => new SlytherParser().parse(new SlytherScript(source, join(dir, "main.sly")), base);
    const named = (source: string, name: string) => at(source).artifacts.find((artifact) => artifact.name === name)!;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "slyther-parser-"));
        await mkdir(join(dir, "docs"));
        await writeFile(join(dir, "docs", "pricing.md"), "\n\n# Pricing\n\nUses #{Nothing} as `code`.\n\n");
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test("from embeds the file as the content, without the blank lines around it, and without reading references in it", () => {
        const artifact = named('@artifact research\nresearch Pricing from "./docs/pricing.md"', "Pricing");

        expect(artifact.content).toBe("# Pricing\n\nUses #{Nothing} as `code`.");
        expect(artifact.prose).toBe(artifact.content);
        expect(artifact.references).toEqual([]);
        expect(artifact.source).toMatchObject({ mode: "from", path: join("docs", "pricing.md") });
    });

    test("ref leaves the content empty and points at the file, relative to the base", () => {
        const artifact = at('@artifact source\nsource Pricing ref "./docs/pricing.md"', join(dir, ".slyther", "src")).artifacts.find((artifact) => artifact.name === "Pricing")!;

        expect(artifact.content).toBe("");
        expect(artifact.source).toMatchObject({ mode: "ref", path: join("..", "..", "docs", "pricing.md") });
        expect(artifact.prose).toBe(`Read \`${join("..", "..", "docs", "pricing.md")}\`: it holds the prose of source Pricing.`);
        expect(artifact.textIn(join(dir, ".slyther", "src"))).toBe("# Pricing\n\nUses #{Nothing} as `code`.");
    });

    test("a change to the file changes the hash, for from and for ref", async () => {
        const script = '@artifact d\nd A from "./docs/pricing.md"\nd B ref "./docs/pricing.md"';
        const before = at(script).artifacts;

        await writeFile(join(dir, "docs", "pricing.md"), "changed");

        const after = at(script).artifacts;

        expect(after.find((artifact) => artifact.name === "A")!.hash).not.toBe(before.find((artifact) => artifact.name === "A")!.hash);
        expect(after.find((artifact) => artifact.name === "B")!.hash).not.toBe(before.find((artifact) => artifact.name === "B")!.hash);
    });

    test("works for a kind, a nested block and a script, and resolves the path relative to the script that imports it", async () => {
        await mkdir(join(dir, "sub"));
        await writeFile(join(dir, "sub", "rules.md"), "the rules");
        await writeFile(join(dir, "sub", "kinds.sly"), '@artifact k ref "./rules.md"');

        const parsed = at('@import "./sub/kinds.sly"\n@artifact j {\n operation create (id: string) {\n  llm fill from "./docs/pricing.md"\n }\n}\n@run dev from "./docs/pricing.md"');
        const byName = (name: string) => parsed.artifacts.find((artifact) => artifact.name === name)!;

        expect(byName("k").source).toMatchObject({ mode: "ref", path: join("sub", "rules.md") });
        expect(byName("j::create::fill").content).toBe("# Pricing\n\nUses #{Nothing} as `code`.");
        expect(byName("j::create").content).toBe("");
        expect(byName("run::dev").source?.mode).toBe("from");
    });

    test("throws on a missing file and on a file with a body as well", () => {
        expect(() => at('@artifact d\nd A from "./docs/none.md"')).toThrow(`Cannot read "./docs/none.md", the prose of "A", from "${join(dir, "main.sly")}".`);
        expect(() => at('@artifact d\nd A ref "./docs/pricing.md" {\n x\n}')).toThrow('"A" takes its prose from "./docs/pricing.md", so it cannot have a body in braces as well.');
    });

    test("ref points at a folder, with a trailing separator, and reads every file it holds", async () => {
        await writeFile(join(dir, "docs", "terms.md"), "the terms");

        const artifact = at('@artifact source\nsource Docs ref "./docs"').artifacts.find((artifact) => artifact.name === "Docs")!;

        expect(artifact.content).toBe("");
        expect(artifact.source).toMatchObject({ mode: "ref", path: `docs${sep}` });
        expect(artifact.prose).toBe(`Read the files in \`docs${sep}\`: they hold the prose of source Docs.`);
        expect(artifact.textIn(dir)).toBe("=== pricing.md ===\n\n# Pricing\n\nUses #{Nothing} as `code`.\n\n=== terms.md ===\n\nthe terms");
    });

    test("a folder changes its hash when any file in it is added, edited or removed, and ignores what a .gitignore does", async () => {
        const script = '@artifact d\nd A ref "./docs"';
        const hash = () => at(script).artifacts.find((artifact) => artifact.name === "A")!.hash;
        const before = hash();

        await writeFile(join(dir, "docs", "terms.md"), "the terms");
        const added = hash();
        expect(added).not.toBe(before);

        await writeFile(join(dir, "docs", "terms.md"), "changed");
        expect(hash()).not.toBe(added);

        await rm(join(dir, "docs", "terms.md"));
        expect(hash()).toBe(before);

        await writeFile(join(dir, "docs", ".gitignore"), "*.log\n");
        const ignoring = hash();

        await writeFile(join(dir, "docs", "noise.log"), "noise");
        expect(hash()).toBe(ignoring);
    });

    test("from cannot point at a folder", () => {
        expect(() => at('@artifact d\nd A from "./docs"')).toThrow(
            '"./docs", the prose of "A", is a folder, which holds no text to embed with from. Point at it with ref instead.',
        );
    });

    test("what an expand emits cannot take its prose from a file", () => {
        const parsed = at("@artifact k\nk P { the p }");
        const parent = parsed.artifacts.find((artifact) => artifact.name === "P")!;

        expect(() => new SlytherParser().extend(parsed, parent, 'k one from "./docs/pricing.md"')).toThrow(
            '"P::one" takes its prose from "./docs/pricing.md", but what an expand emits cannot take its prose from a file.',
        );
    });
});
