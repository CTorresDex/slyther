import { describe, expect, test } from "bun:test";
import { SlytherArtifactKind } from "../src/classes/SlytherArtifactKind.class.ts";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

const kinds = (source: string) => SlytherArtifactKind.of(new SlytherParser().parse(new SlytherScript(`@lang "ts"\n${source}`)));
const LOCATE = "operation locate (id: string): deterministic { finds it }";

describe("SlytherArtifactKind deterministic operations", () => {
    test("a deterministic operation without steps has its content as its only step", () => {
        const [kind] = kinds(`@artifact k {\n ${LOCATE}\n}`);
        const locate = kind!.operation("locate")!;

        expect(locate.deterministic).toBe(true);
        expect(locate.steps).toHaveLength(1);
        expect(locate.steps[0]!.artifact.name).toBe("k::locate::locate");
        expect(locate.steps[0]!.artifact.artifact).toBe("deterministic");
        expect(locate.steps[0]!.artifact.content).toBe("finds it");
        expect(locate.steps[0]!.closureHash).toBe(locate.closureHash);
    });

    test("throws when a deterministic operation contains an llm step", () => {
        expect(() => kinds("@artifact k {\n operation locate: deterministic {\n llm think { x }\n }\n}")).toThrow(
            'Operation "k::locate" is deterministic but contains the llm step "k::locate::think".',
        );
    });

    test("throws when an operation that is not deterministic has no steps", () => {
        expect(() => kinds(`@artifact k {\n ${LOCATE}\n operation evaluate { }\n}`)).toThrow(
            'Operation "k::evaluate" has no steps.',
        );
    });

    test("warns when every step is deterministic but the operation is not qualified", () => {
        const [kind] = kinds(`@artifact k {\n ${LOCATE}\n operation evaluate {\n deterministic check { x }\n }\n}`);

        expect(kind!.operation("evaluate")!.deterministic).toBe(false);
        expect(kind!.warnings).toEqual([
            'Operation "k::evaluate" has only deterministic steps: qualify it as deterministic.',
        ]);
    });
});

describe("SlytherArtifactKind qualifiers", () => {
    test("throws when a kind is qualified", () => {
        expect(() => kinds(`@artifact k: deterministic {\n ${LOCATE}\n}`)).toThrow(
            '"k" cannot be qualified: only an operation may be, as deterministic.',
        );
    });

    test("throws when a step is qualified", () => {
        expect(() =>
            kinds(`@artifact k {\n ${LOCATE}\n operation evaluate {\n llm check: deterministic { x }\n }\n}`),
        ).toThrow('"k::evaluate::check" cannot be qualified: only an operation may be, as deterministic.');
    });

    test("throws on an unknown qualifier", () => {
        expect(() => kinds("@artifact k {\n operation locate: fast { x }\n}")).toThrow(
            'Unknown qualifier "fast" of "k::locate": the only qualifier is deterministic.',
        );
    });
});

describe("SlytherArtifactKind locate", () => {
    test("throws when a kind has operations but no locate", () => {
        expect(() => kinds("@artifact k {\n operation evaluate {\n llm verify { x }\n }\n}")).toThrow(
            'Kind "k" defines operations but no locate operation to find its artifacts with.',
        );
    });

    test("throws when locate is not deterministic", () => {
        expect(() => kinds("@artifact k {\n operation locate {\n llm find { x }\n }\n}")).toThrow(
            'Operation "k::locate" must be deterministic.',
        );
    });

    test("a kind without operations needs no locate", () => {
        const [kind] = kinds("@artifact k { rules }");

        expect(kind!.operations).toHaveLength(0);
        expect(kind!.warnings).toHaveLength(0);
    });
});
