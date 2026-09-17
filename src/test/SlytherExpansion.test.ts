import { describe, expect, test } from "bun:test";
import { SlytherArtifactKind } from "../src/classes/SlytherArtifactKind.class.ts";
import { SlytherExpansion } from "../src/classes/SlytherExpansion.class.ts";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

const K = `@artifact k {
    operation locate (id: string): deterministic { finds it }
    operation create (id: string, content: string, extra: string?): deterministic { makes it }
    operation evaluate (id: string): deterministic { checks it }
}`;
const SPEC = `@lang "sh"
${K}
@artifact plain { rules only }
@artifact c {
    operation expand (id: string): deterministic { emits a #{k} }
}
@artifact d {
    operation expand (id: string): deterministic { emits a #{c} or a #{plain} }
}
c P { the p }
d Q { the q }
k byHand { made by hand }
k P::one { by hand }`;
const setup = () => {
    const parsed = new SlytherParser().parse(new SlytherScript(SPEC));

    return { parsed, kinds: SlytherArtifactKind.of(parsed), P: parsed.artifacts.find((artifact) => artifact.name === "P")!, Q: parsed.artifacts.find((artifact) => artifact.name === "Q")! };
};

describe("SlytherExpansion", () => {
    test("reads what an instance emitted into the script, named after it and referencing it", () => {
        const { parsed, kinds, P } = setup();
        const result = SlytherExpansion.of("k uno { the uno }\nk two (content: \"given\") { }\n", P, kinds, parsed);

        expect(result.emitted).toEqual(["k:P::uno", "k:P::two"]);
        expect(result.parsed.artifacts.find((artifact) => artifact.name === "P::uno")!.references).toEqual(["c:P"]);
        expect(result.parsed.artifacts).toHaveLength(parsed.artifacts.length + 2);
    });

    test("throws, naming the instance, on what cannot be read or is not an artifact", () => {
        const { parsed, kinds, P } = setup();

        expect(() => SlytherExpansion.of("k uno { unterminated", P, kinds, parsed)).toThrow('c:P emitted something that cannot be read: Unterminated k "P::uno".');
        expect(() => SlytherExpansion.of("operation uno { x }", P, kinds, parsed)).toThrow('c:P emitted the operation "P::uno", but it may only emit artifacts.');
        expect(() => SlytherExpansion.of("k one { again }", P, kinds, parsed)).toThrow('c:P emitted something that cannot be read: Duplicate declaration "P::one".');
    });

    test("throws on a kind the expand does not reference, a composite kind, or one that cannot be created", () => {
        const { parsed, kinds, P, Q } = setup();

        expect(() => SlytherExpansion.of("plain uno { x }", P, kinds, parsed)).toThrow(
            'c:P emitted the plain "P::uno", but its expand does not reference plain: it may only emit k.',
        );
        expect(() => SlytherExpansion.of("c one { x }", Q, kinds, parsed)).toThrow('d:Q emitted the c "Q::one", but c is composite: a composite kind cannot emit another.');
        expect(() => SlytherExpansion.of("plain one { x }", Q, kinds, parsed)).toThrow('d:Q emitted the plain "Q::one", but a plain cannot be created: it has no create operation.');
    });

    test("throws when a declaration gives nothing for a param its create needs", () => {
        const { parsed, kinds, P } = setup();

        expect(() => SlytherExpansion.of("k uno", P, kinds, parsed)).toThrow('c:P emitted the k "P::uno" without "content", which its create needs: give it as an arg or as its prose.');
        expect(() => SlytherExpansion.of("k uno (content: \"x\")", P, kinds, parsed)).not.toThrow();
    });

    test("throws when the instance is not of a composite kind", () => {
        const { parsed, kinds } = setup();

        expect(() => SlytherExpansion.of("", parsed.artifacts.find((artifact) => artifact.name === "byHand")!, kinds, parsed)).toThrow("k:byHand is not an instance of a composite kind.");
    });
});
