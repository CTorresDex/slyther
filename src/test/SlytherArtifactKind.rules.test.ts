import { describe, expect, test } from "bun:test";
import { SlytherArtifactKind } from "../src/classes/SlytherArtifactKind.class.ts";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

const kinds = (source: string) => SlytherArtifactKind.of(new SlytherParser().parse(new SlytherScript(`@lang "ts"\n${source}`)));
const kindOf = (source: string, name = "k") => kinds(source).find((kind) => kind.name === name)!;
const LOCATE = "operation locate: deterministic { finds it }";
const TRAIT = `@trait Errors {
    Failures are typed.
    rule via-assert: deterministic { only through $assert }
    rule raw-throw: negative {
        Breaks #{Errors::via-assert}.
        \`\`\`ts
        throw new Error("x")
        \`\`\`
    }
    rule own-layer { names of its own domain }
}`;
const KIND = `${TRAIT}
@artifact k (requirements: string) {
    guidance of k
    rule #{Errors}
    rule shape: deterministic { one definition }
    ${LOCATE}
    operation create { writes it }
}`;

describe("SlytherArtifactKind rules", () => {
    test("a kind has its own rules and the ones it adopts, in order, with their negatives and owners", () => {
        const kind = kindOf(KIND);

        expect(kind.rules.map((rule) => `${rule.artifact.name} ${rule.deterministic ? "script" : "judge"} by ${rule.owner?.artifact.name}`)).toEqual([
            "Errors::via-assert script by Errors",
            "Errors::own-layer judge by Errors",
            "k::shape script by k",
        ]);
        expect(kind.rules[0]!.negatives.map((negative) => negative.artifact.name)).toEqual(["Errors::raw-throw"]);
        expect(kind.rules[0]!.lang).toBe("ts");
        expect(kind.rules[1]!.lang).toBeUndefined();
        expect(kind.traits.map((trait) => trait.artifact.name)).toEqual(["Errors"]);
        expect(kind.guidance).toBe("guidance of k");
    });

    test("the check of every rule is a step of evaluate, before the steps it declares, and an llm rule makes it not deterministic", () => {
        const kind = kindOf(KIND);
        const evaluate = kind.operation("evaluate")!;

        expect(evaluate.deterministic).toBe(false);
        expect(evaluate.role).toBe("reviewer");
        expect(evaluate.steps.map((step) => `${step.artifact.name} ${step.artifact.artifact} ${step.role} ${step.rule?.artifact.name}`)).toEqual([
            "k::evaluate::Errors.via-assert deterministic scribe Errors::via-assert",
            "k::evaluate::Errors.own-layer llm reviewer Errors::own-layer",
            "k::evaluate::k.shape deterministic scribe k::shape",
        ]);

        const declared = kindOf(`@artifact k {\n rule shape: deterministic { one }\n ${LOCATE}\n operation evaluate: deterministic { compiles }\n}`);

        expect(declared.operation("evaluate")!.deterministic).toBe(true);
        expect(declared.operation("evaluate")!.steps.map((step) => step.artifact.name)).toEqual(["k::evaluate::k.shape", "k::evaluate::evaluate"]);
        expect(declared.warnings).toEqual([]);
    });

    test("a deterministic evaluate that gains an llm rule is deterministic no more, and is not told to qualify itself", () => {
        const kind = kindOf(`@artifact k {\n rule judged { by a judge }\n ${LOCATE}\n operation evaluate {\n deterministic compiles { tsc }\n }\n}`);

        expect(kind.operation("evaluate")!.deterministic).toBe(false);
        expect(kind.warnings).toEqual([]);
    });

    test("rules verify create and update, and need a locate as operations do", () => {
        expect(kindOf(`@artifact k {\n rule r { x }\n ${LOCATE}\n operation create { writes }\n}`).operation("evaluate")).toBeDefined();
        expect(() => kinds("@artifact k {\n rule r { x }\n}")).toThrow('Kind "k" defines rules but no locate operation to find its artifacts with.');
        expect(() => kinds(`@artifact k {\n ${LOCATE}\n operation create { writes }\n}`)).toThrow(
            'Kind "k" defines create but no rules and no evaluate operation to verify it with.',
        );
        expect(() => kinds("@artifact c {\n rule r { x }\n operation expand: deterministic { emits }\n}")).toThrow(
            'Kind "c" is composite, since it defines expand, so it cannot have rules: an instance of it has no code of its own to check.',
        );
    });

    test("a negative references the rule it breaks and is never deterministic; only a trait or a plain rule is adopted", () => {
        expect(() => kinds(`@artifact k {\n rule bad: negative { code }\n ${LOCATE}\n}`)).toThrow(
            'Rule "k::bad" is negative, so it must reference the rule it breaks, as #{Kind::rule}.',
        );
        expect(() => kinds(`@artifact k {\n rule r { x }\n rule bad: negative { Breaks #{r} }\n ${LOCATE}\n}`)).toThrow(
            'Rule "k::bad" is negative but holds no code: a negative is the code that breaks a rule, written in a ``` block, so a check can be run against it.',
        );
        expect(() => kinds(`@artifact k {\n rule r { x }\n rule bad: negative, deterministic { breaks #{r} }\n ${LOCATE}\n}`)).toThrow(
            'Rule "k::bad" is negative, a counterexample, so it cannot be deterministic: nothing checks it.',
        );
        expect(() => kinds(`${TRAIT}\n@artifact k {\n rule #{Errors::raw-throw}\n ${LOCATE}\n}`)).toThrow(
            '"k" adopts "Errors::raw-throw", which is not a trait or a rule: a negative or an adoption cannot be adopted.',
        );
        expect(() => kinds(`@artifact k {\n rule #{k}\n ${LOCATE}\n}`)).toThrow('"k" adopts "k", which is not a trait or a rule.');
        expect(() => kinds(`@artifact k {\n ${LOCATE}\n}\nrule k::locate::r { x }`)).toThrow(
            'Rule "k::locate::r" must be declared inside a kind or a trait, or outside any, not inside operation "k::locate".',
        );
    });

    test("a trait adopts a trait, and a cycle throws", () => {
        const kind = kindOf(`${TRAIT}\n@trait Http {\n rule #{Errors}\n rule status { maps codes }\n}\n@artifact k {\n rule #{Http}\n ${LOCATE}\n}`);

        expect(kind.rules.map((rule) => rule.artifact.name)).toEqual(["Errors::via-assert", "Errors::own-layer", "Http::status"]);
        expect(kind.traits.map((trait) => trait.artifact.name)).toEqual(["Http", "Errors"]);
        expect(() => kinds(`@trait A {\n rule #{B}\n}\n@trait B {\n rule #{A}\n}\n@artifact k {\n rule #{A}\n ${LOCATE}\n}`)).toThrow('Trait "A" adopts itself: k adopts A adopts B adopts A.');
    });

    test("a kind gets the assets of the traits it adopts, and an asset lives in a trait or outside any", () => {
        const source = `@trait T {\n asset lib ref "./package.json" to "lib/x.json"\n rule r { x }\n}\n@artifact k {\n rule #{T}\n ${LOCATE}\n}\n@artifact other {\n rule s { y }\n ${LOCATE}\n}`;

        expect(kindOf(source).assets.map((asset) => asset.name)).toEqual(["T::lib"]);
        expect(kindOf(source, "other").assets).toEqual([]);
        expect(() => kinds(`@artifact k {\n ${LOCATE}\n}\nasset k::locate::a ref "./package.json" to "x"`)).toThrow(
            'Asset "k::locate::a" must be declared inside a trait, or outside any, not inside operation "k::locate".',
        );
    });

    test("the guidance hash is the scope hash without traits, and the rules hash covers every rule", () => {
        const plain = kindOf(`@artifact k {\n guidance\n rule r { x }\n ${LOCATE}\n}`);
        const edited = kindOf(`@artifact k {\n guidance\n rule r { y }\n ${LOCATE}\n}`);
        const adopting = kindOf(`${TRAIT}\n@artifact k {\n guidance\n rule #{Errors}\n ${LOCATE}\n}`);

        expect(plain.guidanceHash).toBe(plain.scopeHash);
        expect(edited.guidanceHash).toBe(plain.guidanceHash);
        expect(edited.rulesHash).not.toBe(plain.rulesHash);
        expect(adopting.guidanceHash).not.toBe(adopting.scopeHash);
    });

    test("the rules read as the guidance, every rule under its name, the trait before its rules, and every negative as what never to write", () => {
        expect(kindOf(KIND).rulesOf()).toBe(
            [
                "guidance of k",
                "",
                "### Trait Errors",
                "",
                "Failures are typed.",
                "",
                "### Rule Errors::via-assert (checked by a script)",
                "",
                "only through $assert",
                "",
                "#### Never, as Errors::raw-throw",
                "",
                "Breaks #{Errors::via-assert}.",
                "```ts",
                'throw new Error("x")',
                "```",
                "",
                "### Rule Errors::own-layer (judged)",
                "",
                "names of its own domain",
                "",
                "### Rule k::shape (checked by a script)",
                "",
                "one definition",
            ].join("\n"),
        );
    });
});
