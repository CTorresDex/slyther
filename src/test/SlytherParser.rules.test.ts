import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

const parse = (source: string) => new SlytherParser().parse(new SlytherScript(source));
const find = (source: string, name: string) => parse(source).artifacts.find((artifact) => artifact.name === name)!;
const TRAIT = `@trait Errors {
    Failures are typed.
    rule via-assert: deterministic { only through $assert }
    rule raw-throw: negative {
        Breaks #{Errors::via-assert}.
        \`\`\`ts
        throw new Error("x")
        \`\`\`
    }
}`;

describe("SlytherParser rules and traits", () => {
    test("a rule block inside a kind is a rule named after the kind, left out of its content", () => {
        const source = "@artifact k {\n guidance\n rule shape: deterministic { one definition }\n rule scoped { methods of its own }\n}";

        expect(find(source, "k").content).toBe("guidance");
        expect(find(source, "k::shape")).toMatchObject({ artifact: "rule", qualifiers: ["deterministic"], content: "one definition" });
        expect(find(source, "k::scoped")).toMatchObject({ artifact: "rule", qualifiers: [], content: "methods of its own" });
    });

    test("a trait is an artifact of kind trait holding rules, declared in its namespace", () => {
        expect(find(TRAIT, "Errors")).toMatchObject({ artifact: "trait", content: "Failures are typed." });
        expect(find(TRAIT, "Errors::via-assert").qualifiers).toEqual(["deterministic"]);
        expect(find(TRAIT, "Errors::raw-throw")).toMatchObject({ qualifiers: ["negative"], references: ["rule:Errors::via-assert"] });
        expect(find(`@use Std\n${TRAIT}`, "Std::Errors").artifact).toBe("trait");
    });

    test("a rule may be referenced as Kind::rule from anywhere", () => {
        const source = `${TRAIT}\n@artifact k {\n rule #{Errors}\n operation create { follow #{Errors::via-assert} }\n}`;

        expect(find(source, "k::create").references).toEqual(["rule:Errors::via-assert"]);
    });

    test("rule #{Name} is read as an adoption: a rule named after the last word, qualified as adopts, resolved from outside the kind", () => {
        const source = `@use Std\n${TRAIT}\n@use App\n@artifact k {\n rule #{Std::Errors}\n rule Errors { own rule named like the trait }\n}`;

        expect(() => parse(source)).toThrow('Duplicate declaration "App::k::Errors".');

        const adopted = find(`${TRAIT}\n@artifact k {\n rule #{Errors}\n}`, "k::Errors");

        expect(adopted).toMatchObject({ artifact: "rule", qualifiers: ["adopts"], content: "#{Errors}", references: ["trait:Errors"] });
        expect(find(`${TRAIT}\n@artifact k {\n rule #{Errors::via-assert}\n}`, "k::via-assert").references).toEqual(["rule:Errors::via-assert"]);
    });

    test("an adoption resolves in the namespace of the kind, never in the kind itself", () => {
        const source = `@use App\nrule shared { a rule outside any kind }\n@artifact k {\n rule #{shared}\n}`;

        expect(find(source, "App::k::shared").references).toEqual(["rule:App::shared"]);
        expect(() => parse("@artifact k {\n rule #{Nobody}\n}")).toThrow('Unknown reference "Nobody".');
    });

    test("only a kind or a trait adopts, and a trait takes no args", () => {
        expect(() => parse(`${TRAIT}\n@artifact k {\n operation create {\n  rule #{Errors}\n }\n}`)).toThrow(
            '"rule #{Errors}" adopts a rule inside operation "k::create", but only a kind or a trait adopts one.',
        );
        expect(() => parse("@trait T (a: string) { x }")).toThrow('The trait "T" takes no args: a trait is prose and rules that kinds adopt.');
        expect(() => parse("trait T { x }")).toThrow('A trait is declared as "@trait T", not "trait T".');
        expect(() => parse("@trait { x }")).toThrow('"@trait { x }" is not a trait: write it as @trait Name { ... }.');
        expect(() => parse("@trait T {\n operation create { x }\n}")).toThrow('"operation" cannot be declared inside trait "T".');
    });

    test("a rule inside a trait resolves its references in the trait first", () => {
        const source = "@trait T {\n rule a { one }\n rule b: negative { breaks #{a} }\n}";

        expect(find(source, "T::b").references).toEqual(["rule:T::a"]);
    });
});

describe("SlytherParser assets", () => {
    test("an asset points at what it copies with ref and says where it lands with to, kept as its arg", async () => {
        const folder = await mkdtemp(join(tmpdir(), "slyther-asset-"));

        await writeFile(join(folder, "errors.ts"), "export const x = 1;\n");
        await mkdir(join(folder, "fixtures"));
        await writeFile(join(folder, "fixtures", "a.txt"), "a\n");

        const script = new SlytherScript(`@trait Errors {\n asset errors ref "./errors.ts" to "lib/errors.ts"\n rule r { x }\n}\nasset fixtures ref "./fixtures/" to "test/fixtures"`, join(folder, "main.sly"));
        const parsed = new SlytherParser().parse(script);
        const asset = parsed.artifacts.find((artifact) => artifact.name === "Errors::errors")!;

        expect(asset.artifact).toBe("asset");
        expect(asset.args).toEqual([{ name: "to", kind: "string", value: "lib/errors.ts" }]);
        expect(asset.source).toMatchObject({ mode: "ref", path: "errors.ts" });
        expect(parsed.artifacts.find((artifact) => artifact.name === "fixtures")!.source!.path).toBe(`fixtures${sep}`);

        await rm(folder, { recursive: true, force: true });
    });

    test("an asset needs ref and to, and nothing else lands anywhere", () => {
        expect(() => parse('asset a from "./x.ts" to "x.ts"')).toThrow('The asset "a" takes what it copies with ref, not from: from embeds text, and an asset may be a folder.');
        expect(() => parse('asset a ref "./x.ts"')).toThrow('The asset "a" must say where it lands: write it as asset a ref "./x.ts" to "path".');
        expect(() => parse("asset a { x }")).toThrow('The asset "a" must point at what it copies: write it as asset a ref "path" to "path".');
        expect(() => parse('@artifact k {}\nk a ref "./x.md" to "x.md"')).toThrow(
            '"a" says where it lands with to, but only an asset lands anywhere: a k takes its prose from a file with from or ref alone.',
        );
        expect(() => parse('@artifact k {\n asset a ref "./x.ts" to "x.ts"\n}')).toThrow('"asset" cannot be declared inside artifact "k".');
    });
});
