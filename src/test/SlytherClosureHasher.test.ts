import { describe, expect, test } from "bun:test";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

const parse = (source: string) => new SlytherParser().parse(new SlytherScript(source));
const KIND = (step: string) =>
    `@artifact k {\n rules\n operation locate (id: string): deterministic { x }\n operation evaluate {\n deterministic check { ${step} }\n llm verify { y }\n }\n}`;

describe("SlytherClosureHasher scope hashes", () => {
    test("the closure of a parent changes when a child does, the scope does not", () => {
        const before = parse(KIND("a"));
        const after = parse(KIND("b"));

        expect(before.closureHashes.get("artifact:k")).not.toBe(after.closureHashes.get("artifact:k"));
        expect(before.closureHashes.get("operation:k::evaluate")).not.toBe(after.closureHashes.get("operation:k::evaluate"));
        expect(before.scopeHashes.get("artifact:k")).toBe(after.scopeHashes.get("artifact:k"));
        expect(before.scopeHashes.get("operation:k::evaluate")).toBe(after.scopeHashes.get("operation:k::evaluate"));
    });

    test("the scope still follows references", () => {
        const before = parse("@artifact class\nclass Dep { a }\n@artifact k {\n uses #{Dep}\n}");
        const after = parse("@artifact class\nclass Dep { b }\n@artifact k {\n uses #{Dep}\n}");

        expect(before.scopeHashes.get("artifact:k")).not.toBe(after.scopeHashes.get("artifact:k"));
    });

    test("a leaf has the same closure and scope", () => {
        const parsed = parse("@artifact class\nclass Leaf { a }");

        expect(parsed.scopeHashes.get("class:Leaf")).toBe(parsed.closureHashes.get("class:Leaf"));
    });
});
