import { describe, expect, test } from "bun:test";
import { SlytherArtifactKind } from "../src/classes/SlytherArtifactKind.class.ts";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

const kinds = (source: string) => SlytherArtifactKind.of(new SlytherParser().parse(new SlytherScript(source)));
const LOCATE = "operation locate (id: string): deterministic { finds it }";

describe("SlytherArtifactKind params", () => {
    test("the args of an operation are its params, in order, with optional types", () => {
        const [kind] = kinds(
            `@lang "ts"\n@artifact k {\n ${LOCATE}\n operation create (id: string, content: string?) {\n llm write { x }\n }\n operation evaluate {\n llm check { x }\n }\n}`,
        );

        expect(kind!.operation("create")!.params).toEqual([
            { name: "id", type: "string", optional: false },
            { name: "content", type: "string", optional: true },
        ]);
    });

    test("a param may be a declared artifact", () => {
        const kind = kinds(`@lang "ts"\n@artifact class\nclass Dep { d }\n@artifact k {\n ${LOCATE}\n operation evaluate (dep: Dep) {\n llm check { x }\n }\n}`).find((kind) => kind.name === "k");

        expect(kind!.operation("evaluate")!.params).toEqual([{ name: "dep", type: "Dep", optional: false }]);
    });

    test("throws when an operation arg is not a type", () => {
        expect(() => kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n operation evaluate (lang: "ts") {\n llm check { x }\n }\n}`)).toThrow(
            'Argument "lang" of "k::evaluate" must be a type: the args of an operation are its params.',
        );
    });

    test("throws when locate does not have the params (id: string)", () => {
        expect(() => kinds('@lang "ts"\n@artifact k {\n operation locate: deterministic { x }\n}')).toThrow(
            'Operation "k::locate" must have the params (id: string).',
        );
        expect(() => kinds('@lang "ts"\n@artifact k {\n operation locate (id: string?): deterministic { x }\n}')).toThrow(
            'Operation "k::locate" must have the params (id: string).',
        );
    });

    test("throws when a value that is not a type is optional", () => {
        expect(() => kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n operation evaluate (n: 3?) {\n llm check { x }\n }\n}`)).toThrow(
            'Malformed value "3?" of argument "n" of "k::evaluate".',
        );
    });
});

describe("SlytherArtifactKind lang", () => {
    const STEP = (kind: string, step: string) =>
        `@artifact k ${kind} {\n ${LOCATE}\n operation evaluate {\n deterministic check ${step} { x }\n llm verify { y }\n }\n}`;
    const langOf = (source: string) => kinds(source)[0]!.operation("evaluate")!.steps[0]!.lang;

    test("a step takes its own lang, else the kind's, else the project's", () => {
        expect(langOf(`@lang "ts"\n${STEP('(lang: "py")', '(lang: "sh")')}`)).toBe("sh");
        expect(langOf(`@lang "ts"\n${STEP('(lang: "py")', "")}`)).toBe("py");
        expect(langOf(`@lang "ts"\n${STEP("", "")}`)).toBe("ts");
    });

    test("an llm step has no lang", () => {
        expect(kinds(`@lang "ts"\n${STEP("", "")}`)[0]!.operation("evaluate")!.steps[1]!.lang).toBeUndefined();
    });

    test("throws when a deterministic step has no lang to take", () => {
        expect(() => kinds(STEP("", ""))).toThrow(
            'Step "k::evaluate::check" has no lang: declare it on the step, on the kind, or with @lang on the project.',
        );
    });

    test("throws when an llm step declares a lang", () => {
        expect(() =>
            kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n operation evaluate {\n llm check (lang: "ts") { x }\n }\n}`),
        ).toThrow('Step "k::evaluate::check" is an llm step and cannot declare a lang.');
    });

    test("throws on a configuration other than lang", () => {
        expect(() => kinds(`@lang "ts"\n@artifact k (model: "x") {\n ${LOCATE}\n}`)).toThrow(
            'Unknown configuration "model" of "k": the only configuration is lang.',
        );
    });

    test("throws when a step declares a type", () => {
        expect(() =>
            kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n operation evaluate {\n llm check (id: string) { x }\n }\n}`),
        ).toThrow('Argument "id" of "k::evaluate::check" is a type, but only an operation has params.');
    });

    test("the lang is declared once", () => {
        expect(() => kinds('@lang "ts"\n@lang "py"\n@artifact k { x }')).toThrow(
            'The lang is declared twice: as "ts" and as "py".',
        );
    });
});

describe("SlytherArtifactKind built-in operations", () => {
    test("a kind with operations has list after the ones written, and signature and uses once an instance of it is referenced", () => {
        const [alone] = kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n}\nk a { alone }`);

        expect(alone!.operations.map((operation) => operation.artifact.name)).toEqual(["k::locate", "k::list"]);

        const [self] = kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n}\nk a { refers to #{a} }`);

        expect(self!.operations.map((operation) => operation.artifact.name)).toEqual(["k::locate", "k::list"]);

        const [kind] = kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n}\nk a { the a }\nk b { uses #{a} }`);
        const names = kind!.operations.map((operation) => operation.artifact.name);

        expect(names).toEqual(["k::locate", "k::list", "k::signature", "k::uses"]);

        const signature = kind!.operation("signature")!;

        expect(signature.builtin).toBe(true);
        expect(signature.deterministic).toBe(true);
        expect(signature.params).toEqual([{ name: "id", type: "string", optional: false }]);
        expect(signature.steps[0]!.artifact.name).toBe("k::signature::signature");
        expect(signature.steps[0]!.lang).toBe("ts");
        expect(signature.closureHash).toBe(signature.artifact.hash);
    });

    test("a declared operation replaces the built-in one", () => {
        const [kind] = kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n operation list: deterministic { mine }\n}`);
        const list = kind!.operation("list")!;

        expect(kind!.operations.filter((operation) => operation.artifact.name === "k::list")).toHaveLength(1);
        expect(list.builtin).toBe(false);
        expect(list.artifact.content).toBe("mine");
    });

    test("a kind without operations has no built-in ones", () => {
        expect(kinds("@artifact k { rules }")[0]!.operations).toHaveLength(0);
    });
});
