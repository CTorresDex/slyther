import { describe, expect, test } from "bun:test";
import { SlytherArtifactKind } from "../src/classes/SlytherArtifactKind.class.ts";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

const kinds = (source: string) => SlytherArtifactKind.of(new SlytherParser().parse(new SlytherScript(source)));
const LOCATE = "operation locate: deterministic { finds it }";

describe("SlytherArtifactKind params", () => {
    test("the params of a kind are the id, its own args in order, and the errors an update is run to fix", () => {
        const [kind] = kinds(
            `@lang "ts"\n@artifact k (content: string?) {\n ${LOCATE}\n operation create {\n llm write { x }\n }\n operation update {\n llm fix { x }\n }\n operation evaluate {\n llm check { x }\n }\n}`,
        );

        expect(kind!.params).toEqual([{ name: "content", type: "string", optional: true }]);
        expect(kind!.operation("create")!.params).toEqual([
            { name: "id", type: "string", optional: false },
            { name: "content", type: "string", optional: true },
        ]);
        expect(kind!.operation("evaluate")!.params).toEqual([
            { name: "id", type: "string", optional: false },
            { name: "content", type: "string", optional: true },
        ]);
        expect(kind!.operation("update")!.params).toEqual([
            { name: "id", type: "string", optional: false },
            { name: "content", type: "string", optional: true },
            { name: "errors", type: "string", optional: false },
        ]);
    });

    test("an operation narrows to the params it names, in the order it names them", () => {
        const [kind] = kinds(
            `@lang "ts"\n@artifact k (path: string, content: string) {\n ${LOCATE}\n operation evaluate (content, id) {\n llm check { x }\n }\n}`,
        );

        expect(kind!.operation("evaluate")!.params).toEqual([
            { name: "content", type: "string", optional: false },
            { name: "id", type: "string", optional: false },
        ]);
    });

    test("a param may be a declared artifact", () => {
        const kind = kinds(`@lang "ts"\n@artifact class\nclass Dep { d }\n@artifact k (dep: Dep) {\n ${LOCATE}\n operation evaluate (dep) {\n llm check { x }\n }\n}`).find((kind) => kind.name === "k");

        expect(kind!.operation("evaluate")!.params).toEqual([{ name: "dep", type: "Dep", optional: false }]);
    });

    test("throws when an operation declares a type of its own", () => {
        expect(() => kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n operation evaluate (content: string) {\n llm check { x }\n }\n}`)).toThrow(
            'Argument "content" of "k::evaluate" is a type: the params of a kind are declared on the kind, and an operation narrows to them by name.',
        );
    });

    test("throws when an operation narrows to something its kind does not declare", () => {
        expect(() => kinds(`@lang "ts"\n@artifact k (content: string) {\n ${LOCATE}\n operation evaluate (nope) {\n llm check { x }\n }\n}`)).toThrow(
            'Operation "k::evaluate" takes "nope", which "k" does not declare: it takes id, content.',
        );
        expect(() => kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n operation evaluate (errors) {\n llm check { x }\n }\n}`)).toThrow(
            'Operation "k::evaluate" takes "errors", which "k" does not declare: it takes id.',
        );
        expect(() => kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n operation evaluate (id, id) {\n llm check { x }\n }\n}`)).toThrow(
            'Operation "k::evaluate" takes "id" twice.',
        );
    });

    test("throws when a kind declares a param every kind has, or declares one twice", () => {
        expect(() => kinds(`@lang "ts"\n@artifact k (id: string) {\n ${LOCATE}\n}`)).toThrow(
            'Kind "k" declares the param "id", which every kind has already: id is the name of the instance and errors is what an update is run to fix.',
        );
        expect(() => kinds(`@lang "ts"\n@artifact k (a: string, a: string) {\n ${LOCATE}\n}`)).toThrow(
            'Kind "k" declares the param "a" twice.',
        );
    });

    test("an instance may only give args its kind declares as params", () => {
        expect(() => kinds(`@lang "ts"\n@artifact k (path: string) {\n ${LOCATE}\n}\nk a (path: "here") { x }`)).not.toThrow();
        expect(() => kinds(`@lang "ts"\n@artifact k (path: string) {\n ${LOCATE}\n}\nk a (paht: "here") { x }`)).toThrow(
            'The k "a" gives the arg "paht", which k does not declare: it takes path.',
        );
        expect(() => kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n}\nk a (path: "here") { x }`)).toThrow(
            'The k "a" gives the arg "path", which k does not declare: it takes no args.',
        );
    });

    test("locate takes the id alone unless it names more, and must take it first", () => {
        const [narrow] = kinds(`@lang "ts"\n@artifact k (path: string) {\n ${LOCATE}\n}`);

        expect(narrow!.operation("locate")!.params).toEqual([{ name: "id", type: "string", optional: false }]);

        const [wide] = kinds('@lang "ts"\n@artifact k (path: string) {\n operation locate (id, path): deterministic { prints the path }\n}');

        expect(wide!.operation("locate")!.params).toEqual([
            { name: "id", type: "string", optional: false },
            { name: "path", type: "string", optional: false },
        ]);

        expect(() => kinds('@lang "ts"\n@artifact k (path: string) {\n operation locate (path, id): deterministic { x }\n}')).toThrow(
            'Operation "k::locate" must take the id first.',
        );
    });

    test("throws when a value that is not a type is optional", () => {
        expect(() => kinds(`@lang "ts"\n@artifact k (n: 3?) {\n ${LOCATE}\n}`)).toThrow(
            'Malformed value "3?" of argument "n" of "k".',
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

    test("throws on a configuration other than lang and by", () => {
        expect(() => kinds(`@lang "ts"\n@artifact k (model: "x") {\n ${LOCATE}\n}`)).toThrow(
            'Unknown configuration "model" of "k": the configuration is lang and by.',
        );
    });

    test("throws when a step declares a type", () => {
        expect(() =>
            kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n operation evaluate {\n llm check (id: string) { x }\n }\n}`),
        ).toThrow('Argument "id" of "k::evaluate::check" is a type, but only a kind declares params.');
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

    test("a built-in operation keeps its shape when it is declared by hand", () => {
        const [kind] = kinds(`@lang "ts"\n@artifact k (content: string) {\n ${LOCATE}\n operation list: deterministic { mine }\n operation signature: deterministic { its shape }\n}\nk a { the a }\nk b { uses #{a} }`);

        expect(kind!.operation("list")!.params).toEqual([]);
        expect(kind!.operation("signature")!.params).toEqual([{ name: "id", type: "string", optional: false }]);
    });

    test("a kind without operations has no built-in ones", () => {
        expect(kinds("@artifact k { rules }")[0]!.operations).toHaveLength(0);
    });
});
