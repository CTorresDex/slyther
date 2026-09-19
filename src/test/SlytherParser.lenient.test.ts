import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

const lenient = (source: string, path?: string) => {
    const parser = new SlytherParser({ lenient: true });
    const parsed = parser.parse(new SlytherScript(source, path));

    return { parsed, map: parser.map };
};
const strict = (source: string) => {
    const parser = new SlytherParser();
    const parsed = parser.parse(new SlytherScript(source));

    return { parsed, map: parser.map };
};

describe("SlytherParser source map", () => {
    test("records where every declaration opens and closes, and the columns of its kind and its name", () => {
        const { map } = strict("@artifact k {\n  operation create (id: string) {\n    does it\n  }\n}\nk A { a }");
        const [kind, create, a] = map.declarations;

        expect(kind).toMatchObject({ name: "k", artifact: "artifact", line: 0, last: 4, kind: { start: 0, end: 9 }, at: { start: 10, end: 11 } });
        expect(create).toMatchObject({ name: "k::create", artifact: "operation", scope: "k", line: 1, last: 3, kind: { start: 2, end: 11 }, at: { start: 12, end: 18 } });
        expect(a).toMatchObject({ name: "A", artifact: "k", line: 5, last: 5, kind: { start: 0, end: 1 }, at: { start: 2, end: 3 } });
    });

    test("records every reference where it sits, with what it resolves to", () => {
        const { map } = strict("@artifact k\nk A { sees #{B} and `#{A}` }\nk B (x: A) { \\#{A} }");
        const references = map.references.map((reference) => `${reference.role}:${reference.name}@${reference.line}:${reference.start}-${reference.end}->${reference.target}`);

        expect(references).toEqual(["kind:k@1:0-1->k", "reference:B@1:13-14->B", "kind:k@2:0-1->k", "type:A@2:8-9->A"]);
    });

    test("a reference on the opening line of a nested block, and after an escaped line, sits at its real columns", () => {
        const { map } = strict("@artifact k {\n  operation create (id: string) { uses #{k}\n    \\operation x { and #{k} }\n  }\n}");
        const references = map.references.filter((reference) => reference.role === "reference");

        expect(references.map((reference) => `${reference.line}:${reference.start}-${reference.end}`)).toEqual(["1:41-42", "2:25-26"]);
    });

    test("records the paths of imports and sources with what they resolve to", async () => {
        const folder = await mkdtemp(join(tmpdir(), "slyther-map-"));

        await writeFile(join(folder, "other.sly"), "@artifact k\n");
        await writeFile(join(folder, "prose.md"), "the prose\n");

        const parser = new SlytherParser();

        parser.parse(new SlytherScript('@import "./other.sly"\nk A from "./prose.md"\nk B ref "./prose.md"', join(folder, "main.sly")));

        expect(parser.map.files).toEqual([join(folder, "main.sly"), join(folder, "other.sly")]);
        expect(parser.map.paths).toEqual([
            { file: join(folder, "main.sly"), line: 0, start: 9, end: 20, directive: "import", path: join(folder, "other.sly") },
            { file: join(folder, "main.sly"), line: 1, start: 10, end: 20, directive: "from", path: join(folder, "prose.md") },
            { file: join(folder, "main.sly"), line: 2, start: 9, end: 19, directive: "ref", path: join(folder, "prose.md") },
        ]);

        await rm(folder, { recursive: true, force: true });
    });

    test("finds what is written under a position and the block around a line", () => {
        const { map } = strict("@artifact k\nk A { sees #{B} }\nk B {\n  b\n}");

        expect(map.at("", 1, 2)).toMatchObject({ kind: "declaration", declaration: { name: "A" } });
        expect(map.at("", 1, 13)).toMatchObject({ kind: "reference", reference: { name: "B", target: "B" } });
        expect(map.at("", 1, 0)).toMatchObject({ kind: "reference", reference: { role: "kind", name: "k" } });
        expect(map.at("", 1, 7)).toBeUndefined();
        expect(map.enclosing("", 3)?.name).toBe("B");
        expect(map.enclosing("", 1)?.name).toBe("A");
    });
});

describe("SlytherParser lenient", () => {
    const broken = [
        '@lang "ts"',
        '@lang "py"',
        "@artifact k {",
        "  operation create (id: string, x: Nope) {",
        "    uses #{Missing} and #{k}",
        "    llm { no name }",
        "  }",
        "}",
        "k A { a }",
        "k A { again }",
        "zz B { unknown kind }",
        "k D { unterminated",
    ].join("\n");

    test("keeps reading after a problem and reports each one where it is", () => {
        const { parsed, map } = lenient(broken);

        expect(parsed.artifacts.map((artifact) => `${artifact.artifact}:${artifact.name}`)).toEqual(["artifact:k", "operation:k::create", "k:A", "zz:B", "k:D"]);
        expect(parsed.lang).toBe("ts");
        expect(map.diagnostics.map((diagnostic) => `${diagnostic.line}:${diagnostic.start}-${diagnostic.end} ${diagnostic.message}`)).toEqual([
            '1:0-10 The lang is declared twice: as "ts" and as "py".',
            '5:0-19 The llm block inside operation "k::create" needs a name, as in "llm setup {".',
            '9:2-3 Duplicate declaration "A".',
            '10:0-21 Unknown artifact "zz" of "B".',
            '11:0-18 Unterminated k "D".',
            '3:32-39 Unknown type "Nope" of argument "x" of "k::create".',
            '4:11-18 Unknown reference "Missing".',
        ]);
        expect(map.diagnostics[0]).toEqual({ file: "", line: 1, start: 0, end: 10, message: 'The lang is declared twice: as "ts" and as "py".', severity: "error" });
        expect(parsed.artifacts.find((artifact) => artifact.name === "A")!.content).toBe("again");
        expect(parsed.artifacts.find((artifact) => artifact.name === "k::create")!.references).toEqual(["artifact:k"]);
    });

    test("strict mode still throws the first problem", () => {
        expect(() => new SlytherParser().parse(new SlytherScript(broken))).toThrow('The lang is declared twice: as "ts" and as "py".');
    });

    test("reads what the reader gives instead of the disk, and reports a path that neither holds", async () => {
        const folder = await mkdtemp(join(tmpdir(), "slyther-lenient-"));
        const main = join(folder, "main.sly");
        const other = join(folder, "other.sly");
        const parser = new SlytherParser({ lenient: true, read: (path) => (path === other ? "@artifact k\nk A { a }" : undefined) });
        const parsed = parser.parse(new SlytherScript('@import "./other.sly"\n@import "./missing.sly"\nk B from "./gone.md"', main));

        expect(parsed.artifacts.map((artifact) => artifact.name)).toEqual(["k", "A", "B"]);
        expect(parser.map.diagnostics.map((diagnostic) => `${diagnostic.line}:${diagnostic.start}-${diagnostic.end} ${diagnostic.message}`)).toEqual([
            `1:0-23 Cannot import "./missing.sly" from "${main}".`,
            `2:10-19 Cannot read "./gone.md", the prose of "B", from "${main}".`,
        ]);
        expect(parsed.artifacts.find((artifact) => artifact.name === "B")!.source).toMatchObject({ mode: "from", path: "gone.md" });

        await rm(folder, { recursive: true, force: true });
    });

    test("a block with both a file and a brace keeps the brace, and a missing parent is reported on the name", () => {
        const { parsed, map } = lenient('@artifact k\nk A from "./x.md" { the body }\nk Gone::B { b }');

        expect(parsed.artifacts.find((artifact) => artifact.name === "A")!.content).toBe("the body");
        expect(map.diagnostics.map((diagnostic) => `${diagnostic.line}:${diagnostic.start}-${diagnostic.end} ${diagnostic.message}`)).toEqual([
            '1:0-30 "A" takes its prose from "./x.md", so it cannot have a body in braces as well.',
            '2:2-9 Unknown parent "Gone" of "Gone::B".',
        ]);
    });
});
