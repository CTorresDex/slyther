import { describe, expect, test } from "bun:test";
import { SlytherArtifactKind } from "../src/classes/SlytherArtifactKind.class.ts";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

const kinds = (source: string) => SlytherArtifactKind.of(new SlytherParser().parse(new SlytherScript(`@lang "ts"\n${source}`)));
const LOCATE = "operation locate: deterministic { finds it }";

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

    test("an operation that is not deterministic without steps has its content as its only llm step", () => {
        const [kind] = kinds(`@artifact k {\n ${LOCATE}\n operation evaluate { checks it }\n}`);
        const evaluate = kind!.operation("evaluate")!;

        expect(evaluate.deterministic).toBe(false);
        expect(evaluate.steps).toHaveLength(1);
        expect(evaluate.steps[0]!.artifact.name).toBe("k::evaluate::evaluate");
        expect(evaluate.steps[0]!.artifact.artifact).toBe("llm");
        expect(evaluate.steps[0]!.artifact.content).toBe("checks it");
        expect(evaluate.steps[0]!.lang).toBeUndefined();
        expect(evaluate.steps[0]!.closureHash).toBe(evaluate.closureHash);
    });

    test("throws when an operation that is not deterministic has neither steps nor content", () => {
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
    test("throws when a kind is qualified as deterministic, which only an operation may be", () => {
        expect(() => kinds(`@artifact k: deterministic {\n ${LOCATE}\n}`)).toThrow(
            'Unknown qualifier "deterministic" of "k": the only qualifier of a kind is demanded.',
        );
    });

    test("throws when a step is qualified", () => {
        expect(() =>
            kinds(`@artifact k {\n ${LOCATE}\n operation evaluate {\n llm check: deterministic { x }\n }\n}`),
        ).toThrow('"k::evaluate::check" cannot be qualified: only a kind may be, as demanded, an operation, as deterministic, and a rule, as deterministic or negative.');
    });

    test("throws on an unknown qualifier", () => {
        expect(() => kinds("@artifact k {\n operation locate: fast { x }\n}")).toThrow(
            'Unknown qualifier "fast" of "k::locate": the only qualifier of an operation is deterministic.',
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

describe("SlytherArtifactKind composite", () => {
    const COMPOSITE = `@artifact k {\n ${LOCATE}\n}\n@artifact c {\n operation expand: deterministic { emits a #{k} }\n}`;

    test("a kind with expand is composite: it needs no locate, gets no built-in operation, and emits the kinds expand references", () => {
        const c = kinds(COMPOSITE).find((kind) => kind.name === "c")!;

        expect(c.composite).toBe(true);
        expect(c.emits).toEqual(["k"]);
        expect(c.operations.map((operation) => operation.artifact.name)).toEqual(["c::expand"]);
        expect(kinds(COMPOSITE).find((kind) => kind.name === "k")!.composite).toBe(false);
    });

    test("throws when expand is not deterministic or the kind defines anything else", () => {
        expect(() => kinds("@artifact c {\n operation expand { emits }\n}")).toThrow('Operation "c::expand" must be deterministic.');
        expect(() => kinds(`@artifact c {\n ${LOCATE}\n operation expand: deterministic { emits }\n}`)).toThrow(
            'Kind "c" is composite, since it defines expand, so it cannot define "locate": an instance of it has no code of its own.',
        );
    });
});

describe("SlytherArtifactKind demanded kinds", () => {
    const DEMANDED = `@artifact u: demanded {
 ${LOCATE}
 operation create { writes it }
 operation evaluate { checks it }
}`;

    test("a kind qualified as demanded is demanded, and every other is not", () => {
        const [kind] = kinds(DEMANDED);

        expect(kind!.demanded).toBe(true);
        expect(kinds(`@artifact k {\n ${LOCATE}\n}`)[0]!.demanded).toBe(false);
    });

    test("every operation of a demanded kind takes the demands after the id", () => {
        const [kind] = kinds(DEMANDED);

        expect(kind!.operation("create")!.params.map((param) => param.name)).toEqual(["id", "demands"]);
        expect(kind!.operation("evaluate")!.params.map((param) => param.name)).toEqual(["id", "demands"]);
    });

    test("the read-only operations of a demanded kind keep their shape", () => {
        const [kind] = kinds(DEMANDED);

        expect(kind!.operation("locate")!.params.map((param) => param.name)).toEqual(["id"]);
        expect(kind!.operation("uses")!.params.map((param) => param.name)).toEqual(["id"]);
        expect(kind!.operation("list")!.params).toEqual([]);
    });

    test("a demanded kind is always built a signature and a uses, since nothing references its instances", () => {
        const [kind] = kinds(DEMANDED);

        expect(kind!.operations.map((operation) => operation.artifact.name)).toContain("u::signature");
        expect(kind!.operations.map((operation) => operation.artifact.name)).toContain("u::uses");
    });

    test("a kind whose rules reference a demanded kind is built a uses, since only it can name what it asked for", () => {
        const [, asker] = kinds(`${DEMANDED}\n@artifact k {\n its utilities live in a #{u}\n ${LOCATE}\n}`);

        expect(asker!.operations.map((operation) => operation.artifact.name)).toContain("k::uses");
    });

    test("a kind that references no demanded kind, and that nothing references, is built neither", () => {
        const [kind] = kinds(`@artifact k {\n ${LOCATE}\n}`);

        expect(kind!.operations.map((operation) => operation.artifact.name)).not.toContain("k::uses");
    });

    test("throws when a demanded kind has no create, since an instance of it could never be made", () => {
        expect(() => kinds(`@artifact u: demanded {\n ${LOCATE}\n}`)).toThrow(
            'Kind "u" is demanded but defines no create operation: an instance of it could never be made.',
        );
    });

    test("throws when a demanded kind is composite", () => {
        expect(() => kinds("@artifact u: demanded {\n operation expand: deterministic { emits }\n}")).toThrow(
            'Kind "u" is demanded and composite: an instance with no code of its own can never be asked for a member.',
        );
    });

    test("throws when the locate of a demanded kind takes more than the id", () => {
        expect(() =>
            kinds(`@artifact u (where: string?): demanded {\n operation locate (id, where): deterministic { finds it }\n operation create { writes it }\n operation evaluate { checks it }\n}`),
        ).toThrow(
            'Operation "u::locate" takes id, where, but "u" is demanded: it must take the id alone, since a demand names an instance and nothing else.',
        );
    });

    test("throws when a demanded kind declares a param that is not optional", () => {
        expect(() =>
            kinds(`@artifact u (spec: string): demanded {\n ${LOCATE}\n operation create { writes it }\n operation evaluate { checks it }\n}`),
        ).toThrow(
            'Kind "u" is demanded and declares the param "spec", which is not optional: an instance nobody declares has nothing to fill it from, so every param of a demanded kind must be optional.',
        );
    });

    test("a demanded kind may declare an optional param, which an instance nobody declares simply has not", () => {
        const [kind] = kinds(`@artifact u (spec: string?): demanded {\n ${LOCATE}\n operation create { writes it }\n operation evaluate { checks it }\n}`);

        expect(kind!.operation("create")!.params.map((param) => param.name)).toEqual(["id", "demands", "spec"]);
    });
});
