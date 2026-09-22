import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherArtifactKind } from "../src/classes/SlytherArtifactKind.class.ts";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

let root = "";

/** Writes a package of the given name, its entry point holding the given source. */
const install = async (name: string, files: Record<string, string>) => {
    for (const [path, source] of Object.entries(files)) {
        const file = join(root, SlytherParser.PACKAGES, name, path);

        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, source);
    }
};

const parse = (source: string) => new SlytherParser().parse(new SlytherScript(source, join(root, "main.sly")));

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "slyther-packages-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("SlytherParser packages", () => {
    test("an import of a bare name reads the entry point of the package installed under the project", async () => {
        await install("bun", { "main.sly": '@artifact BunProject (lang: "ts") {\n the rules\n}' });

        const parsed = parse('@import "bun"');

        expect(parsed.artifacts.map((artifact) => artifact.name)).toEqual(["BunProject"]);
        expect(parsed.artifacts[0]!.content).toBe("the rules");
    });

    test("every artifact a package pulls in is known to be its, however many relative imports away", async () => {
        await install("bun", {
            "main.sly": '@import "./artifacts/BunProject.sly"',
            "artifacts/BunProject.sly": '@import "./Util.sly"\n@artifact BunProject (lang: "ts") { rules }',
            "artifacts/Util.sly": '@artifact Util (lang: "ts") { rules }',
        });

        const parsed = parse('@import "bun"');

        expect(parsed.packages.get("BunProject")).toBe("bun");
        expect(parsed.packages.get("Util")).toBe("bun");
    });

    test("what the project declares itself belongs to no package", async () => {
        await install("bun", { "main.sly": '@artifact BunProject (lang: "ts") { rules }' });

        const parsed = parse('@import "bun"\n@artifact mine { rules }');

        expect(parsed.packages.get("BunProject")).toBe("bun");
        expect(parsed.packages.has("mine")).toBe(false);
    });

    test("a package that is not installed fails naming the package and where it was looked for", () => {
        expect(() => parse('@import "bun"')).toThrow(
            `Cannot import the package "bun": nothing is installed at "${join(root, SlytherParser.PACKAGES, "bun", "main.sly")}".`,
        );
    });

    test("a path is never read as a package", async () => {
        await writeFile(join(root, "other.sly"), "@artifact k { rules }");

        expect(parse('@import "./other.sly"').artifacts.map((artifact) => artifact.name)).toEqual(["k"]);
        expect(() => parse('@import "../bun"')).toThrow(/Cannot import "\.\.\/bun"/);
        expect(() => parse('@import "C:/packages/bun"')).toThrow(/Cannot import "C:\/packages\/bun"/);
    });

    test("the packages folder can be given instead of the one under the entry point", async () => {
        const elsewhere = await mkdtemp(join(tmpdir(), "slyther-elsewhere-"));

        await mkdir(join(elsewhere, "bun"), { recursive: true });
        await writeFile(join(elsewhere, "bun", "main.sly"), "@artifact BunProject { rules }");

        const parsed = new SlytherParser({ packages: elsewhere }).parse(new SlytherScript('@import "bun"', join(root, "main.sly")));

        expect(parsed.packages.get("BunProject")).toBe("bun");

        await rm(elsewhere, { recursive: true, force: true });
    });

    test("the path the import resolves to is recorded where it was written", async () => {
        await install("bun", { "main.sly": "@artifact BunProject { rules }" });

        const parser = new SlytherParser();

        parser.parse(new SlytherScript('@import "bun"', join(root, "main.sly")));

        expect(parser.map.paths[0]).toMatchObject({
            directive: "import",
            path: join(root, SlytherParser.PACKAGES, "bun", "main.sly"),
        });
    });
});

describe("SlytherArtifactKind packaged lang", () => {
    const kinds = async (source: string) => {
        await install("bun", { "main.sly": source });

        return SlytherArtifactKind.of(parse('@lang "py"\n@import "bun"'));
    };

    test("the @lang of the project does not reach a kind that came from a package", async () => {
        expect(kinds("@artifact BunProject {\n operation locate: deterministic { finds it }\n}")).rejects.toThrow(
            'Step "BunProject::locate::locate" has no lang: the kind "BunProject" comes from the package "bun", so it must declare it on the step or on the kind, since the @lang of the project does not reach a package.',
        );
    });

    test("a packaged kind that declares its own lang keeps it, whatever the project declares", async () => {
        const [kind] = await kinds('@artifact BunProject (lang: "ts") {\n operation locate: deterministic { finds it }\n}');

        expect(kind!.operation("locate")!.steps[0]!.lang).toBe("ts");
    });

    test("a step of a packaged kind narrows the lang of its kind, and neither reaches for the project", async () => {
        const [kind] = await kinds(
            '@artifact BunProject (lang: "ts") {\n operation locate: deterministic { finds it }\n operation evaluate {\n  deterministic shape (lang: "sh") { checks it }\n }\n}',
        );

        expect(kind!.operation("locate")!.steps[0]!.lang).toBe("ts");
        expect(kind!.operation("evaluate")!.steps[0]!.lang).toBe("sh");
    });

    test("a kind the project declares itself still falls back to the @lang of the project", () => {
        const [kind] = SlytherArtifactKind.of(parse('@lang "py"\n@artifact mine {\n operation locate: deterministic { finds it }\n}'));

        expect(kind!.operation("locate")!.steps[0]!.lang).toBe("py");
    });
});

describe("SlytherParser namespaced kinds", () => {
    test("a kind is declared in the namespace it is written in", () => {
        const parsed = parse("@use bun\n@artifact BunProject { rules }");

        expect(parsed.artifacts.map((artifact) => artifact.name)).toContain("bun::BunProject");
    });

    test("a declaration written in the namespace names its kind short", () => {
        const parsed = parse("@use bun\n@artifact BunProject { rules }\nBunProject main { does it }");
        const instance = parsed.artifacts.find((artifact) => artifact.name === "bun::main")!;

        expect(instance.artifact).toBe("bun::BunProject");
    });

    test("a declaration outside the namespace names its kind qualified", async () => {
        await install("bun", { "main.sly": "@use bun\n@artifact BunProject { rules }" });

        const parsed = parse('@import "bun"\nbun::BunProject main { does it }');
        const instance = parsed.artifacts.find((artifact) => artifact.name === "main")!;

        expect(instance.artifact).toBe("bun::BunProject");
    });

    test("a kind out of scope is not found, and the error says where it is declared", async () => {
        await install("bun", { "main.sly": "@use bun\n@artifact BunProject { rules }" });

        expect(() => parse('@import "bun"\nBunProject main { does it }')).toThrow(
            'Unknown artifact "BunProject" of "main": "bun::BunProject" declares it elsewhere, so write it qualified or open its namespace with @use.',
        );
    });

    test("the error names every namespace that declares the kind", async () => {
        await install("bun", { "main.sly": "@use bun\n@artifact Util { rules }" });
        await install("node", { "main.sly": "@use node\n@artifact Util { rules }" });

        expect(() => parse('@import "bun"\n@import "node"\nUtil x { does it }')).toThrow(
            /"bun::Util" and "node::Util" declare it elsewhere/,
        );
    });

    test("two packages may declare a kind of the same name", async () => {
        await install("bun", { "main.sly": "@use bun\n@artifact Util { rules }" });
        await install("node", { "main.sly": "@use node\n@artifact Util { rules }" });

        const parsed = parse('@import "bun"\n@import "node"\nbun::Util mine { does it }');

        expect(parsed.packages.get("bun::Util")).toBe("bun");
        expect(parsed.packages.get("node::Util")).toBe("node");
        expect(parsed.artifacts.find((artifact) => artifact.name === "mine")!.artifact).toBe("bun::Util");
    });

    test("the kind a declaration opens with points at where it was declared", () => {
        const parser = new SlytherParser();

        parser.parse(new SlytherScript("@use bun\n@artifact BunProject { rules }\nBunProject main { does it }", join(root, "main.sly")));

        expect(parser.map.references.find((reference) => reference.role === "kind" && reference.owner === "bun::main")!.target).toBe("bun::BunProject");
    });

    test("a kind of a package is built into a folder of its own, with no colon in its name", () => {
        expect(SlytherArtifactKind.folderOf("bun::BunProject")).toBe("bun.BunProject");
        expect(SlytherArtifactKind.folderOf("Util")).toBe("Util");
    });
});
