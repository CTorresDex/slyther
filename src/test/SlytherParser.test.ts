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
