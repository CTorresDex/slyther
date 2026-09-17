import { describe, expect, test } from "bun:test";
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
