import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCLIGenerator } from "../src/classes/ClaudeCLIGenerator.class.ts";
import { SlytherArtifactKind } from "../src/classes/SlytherArtifactKind.class.ts";
import { SlytherParser } from "../src/classes/SlytherParser.class.ts";
import { SlytherProviders } from "../src/classes/SlytherProviders.class.ts";
import { SlytherRole } from "../src/classes/SlytherRole.class.ts";
import { SlytherScript } from "../src/classes/SlytherScript.class.ts";

const parse = (source: string) => new SlytherParser().parse(new SlytherScript(source));
const kinds = (source: string) => SlytherArtifactKind.of(parse(source));
const LOCATE = "operation locate: deterministic { finds it }";
/** A kind with a script, a create written by an llm and an evaluate judged by one, each open to a by. */
const KIND = (kind = "", create = "", step = "", judge = "") => `@lang "ts"
@artifact k ${kind}{
    ${LOCATE}
    operation create ${create}{
        deterministic scaffold ${step}{ makes the file }
        llm fill { fills the file }
    }
    operation evaluate {
        deterministic shape { checks its shape }
        llm scope ${judge}{ judges its scope }
    }
}`;
const rolesOf = (source: string) => {
    const [kind] = kinds(source);

    return Object.fromEntries(
        kind!.operations.flatMap((operation) => [
            ...(operation.role ? [[SlytherArtifactKind.folderOf(operation.artifact.name), operation.role]] : []),
            ...operation.steps.map((step) => [step.artifact.name, step.role]),
        ]),
    );
};

describe("@role", () => {
    test("binds who plays a role, with the options as they are, and changes no hash", () => {
        const bound = parse(`@role reviewer "claude-cli" (model: "claude-haiku-4-5-20251001", effort: 'low')\n@role engineer "claude-cli"\n${KIND()}`);
        const unbound = parse(KIND());

        expect(Object.fromEntries([...bound.roles].map(([role, binding]) => [role, { provider: binding.provider, options: binding.options }]))).toEqual({
            reviewer: { provider: "claude-cli", options: { model: "claude-haiku-4-5-20251001", effort: "low" } },
            engineer: { provider: "claude-cli", options: {} },
        });
        expect([...bound.closureHashes]).toEqual([...unbound.closureHashes]);
        expect([...bound.scopeHashes]).toEqual([...unbound.scopeHashes]);
    });

    test("throws on a name that is not a role, a role bound twice, and an option that is not a quoted string", () => {
        expect(() => parse('@role judge "claude-cli"')).toThrow('"judge" is not a role: the roles that write are scribe, engineer, architect, and the ones that judge are checker, reviewer, auditor.');
        expect(() => parse('@role reviewer "claude-cli"\n@role reviewer "codex"')).toThrow('The role "reviewer" is bound twice: at the script:1 and at the script:2.');
        expect(() => parse('@role reviewer "claude-cli" (model: haiku)')).toThrow('"model: haiku" is not an option of the role "reviewer": write it as name: "value".');
        expect(() => parse('@role reviewer "claude-cli" (model: "a", model: "b")')).toThrow('The role "reviewer" is given the option "model" twice.');
        expect(() => parse("@role reviewer claude-cli")).toThrow('"@role reviewer claude-cli" is not a role: write it as @role name "provider" (option: "value", ...).');
    });

    describe("in a package", () => {
        let root = "";

        beforeEach(async () => {
            root = await mkdtemp(join(tmpdir(), "slyther-roles-"));
        });

        afterEach(async () => {
            await rm(root, { recursive: true, force: true });
        });

        test("throws, since the project that uses a package binds the roles", async () => {
            const file = join(root, SlytherParser.PACKAGES, "kit", "main.sly");

            await mkdir(join(file, ".."), { recursive: true });
            await writeFile(file, '@role engineer "claude-cli" (model: "x")\n@artifact Kit (lang: "ts") { rules }');

            expect(() => new SlytherParser().parse(new SlytherScript('@import "kit"', join(root, "main.sly")))).toThrow(
                'The package "kit" binds the role "engineer", but a package only says what its work needs with by: the project that uses it binds the roles.',
            );
        });
    });
});

describe("by", () => {
    test("each work has its role when nothing names one: the scribe writes scripts, the engineer the rest, the reviewer judges", () => {
        expect(rolesOf(KIND())).toMatchObject({
            "k::create::scaffold": "scribe",
            "k::create::fill": "engineer",
            "k.create": "engineer",
            "k::evaluate::shape": "scribe",
            "k::evaluate::scope": "reviewer",
            "k.evaluate": "reviewer",
            "k::locate::locate": "scribe",
        });
    });

    test("the by of a step decides, then of its operation, then of its kind, each for the work of its own line", () => {
        expect(rolesOf(KIND('(by: "architect") ', "", "", '(by: "auditor") '))).toMatchObject({
            "k::create::scaffold": "scribe",
            "k::create::fill": "architect",
            "k::locate::locate": "scribe",
            "k::evaluate::scope": "auditor",
            "k.evaluate": "auditor",
        });
        expect(rolesOf(KIND('(by: "checker") ', '(by: "architect") ', '(by: "engineer") '))).toMatchObject({
            "k::create::scaffold": "engineer",
            "k::create::fill": "architect",
            "k::evaluate::shape": "scribe",
            "k::evaluate::scope": "checker",
        });
    });

    test("the markdown of an operation is run by the most demanding role among its llm steps", () => {
        const [kind] = kinds(`@lang "ts"\n@artifact k {\n ${LOCATE}\n operation create {\n llm draft { x }\n llm design (by: "architect") { y }\n }\n operation evaluate {\n llm check (by: "checker") { z }\n }\n}`);

        expect(kind!.operation("create")!.role).toBe("architect");
        expect(kind!.operation("evaluate")!.role).toBe("checker");
    });

    test("throws on a role of the other line on a step, on what is not a role, and on a param named by", () => {
        expect(() => kinds(KIND("", "", "", '(by: "architect") '))).toThrow(
            'Step "k::evaluate::scope" is done by the architect, who writes, but its work is to judge: it takes one of checker, reviewer, auditor.',
        );
        expect(() => kinds(KIND("", "", '(by: "auditor") '))).toThrow(
            'Step "k::create::scaffold" is done by the auditor, who judges, but its work is to be written as a script: it takes one of scribe, engineer, architect.',
        );
        expect(() => kinds(KIND('(by: "boss") '))).toThrow('"k" is done by "boss", which is not a role');
        expect(() => kinds(`@artifact k (by: string) {\n ${LOCATE}\n}`)).toThrow('Kind "k" declares the param "by", which names the role its work is done by: name the param otherwise.');
    });

    test("who does the work changes no hash, so choosing another rebuilds nothing", () => {
        const plain = parse(KIND());
        const staffed = parse(KIND('(by: "architect") ', '(by: "architect") ', '(by: "engineer") ', '(by: "auditor") '));

        expect([...staffed.closureHashes]).toEqual([...plain.closureHashes]);
        expect([...staffed.scopeHashes]).toEqual([...plain.scopeHashes]);
    });
});

describe("SlytherRole", () => {
    const roles = new Map<string, SlytherRole["binding"]>([
        ["engineer", { provider: "claude-cli", options: { model: "m1", effort: "low" }, file: "", line: 0 }],
        ["auditor", { provider: "claude-cli", options: { model: "m2" }, file: "", line: 1 }],
    ]);

    test("a role nobody binds is played by the standard role of its line, and by nobody when that is not bound either", () => {
        expect(SlytherRole.cast("architect", roles)).toEqual({ role: "architect", by: { role: "engineer", provider: "claude-cli", options: { model: "m1", effort: "low" } } });
        expect(SlytherRole.cast("auditor", roles).by?.role).toBe("auditor");
        expect(SlytherRole.cast("checker", roles)).toEqual({ role: "checker" });
    });

    test("a cast is recorded alike exactly when the same provider is asked the same way", () => {
        const reordered = new Map<string, SlytherRole["binding"]>([["engineer", { provider: "claude-cli", options: { effort: "low", model: "m1" }, file: "x", line: 9 }]]);

        expect(SlytherRole.fingerprintOf(SlytherRole.cast("engineer", roles))).toBe(SlytherRole.fingerprintOf(SlytherRole.cast("engineer", reordered)));
        expect(SlytherRole.fingerprintOf(SlytherRole.cast("scribe", roles))).not.toBe(SlytherRole.fingerprintOf(SlytherRole.cast("engineer", roles)));
        expect(SlytherRole.fingerprintOf(SlytherRole.cast("checker", roles))).toBe("checker=nobody");
    });
});

describe("SlytherProviders", () => {
    const cast = (role: string, provider: string, options: Record<string, string>) => SlytherRole.cast(role, new Map([[role, { provider, options, file: "", line: 0 }]]));

    test("names a role nobody plays, a provider that is not one, and what the provider says of its options, once per role", () => {
        const problems = new SlytherProviders().problemsWith([
            { role: "auditor" },
            { role: "auditor" },
            cast("engineer", "codex", { model: "x" }),
            cast("reviewer", "claude-cli", { model: "default", temperature: "0" }),
            cast("scribe", "claude-cli", { effort: "low" }),
            cast("checker", "claude-cli", { model: "claude-haiku-4-5-20251001", effort: "low" }),
        ]);

        expect(problems).toEqual([
            'Nobody plays the auditor, nor the reviewer who would stand in for it: bind it with @role reviewer "<provider>" (model: "<model id>"). The providers are claude-cli.',
            'The engineer is played by "codex", which is not a provider: the providers are claude-cli.',
            'The reviewer, played by claude-cli: the option "temperature" is not one the Claude CLI takes: it takes model and effort.',
            'The reviewer, played by claude-cli: the model "default" is whatever whoever runs the build chose, so two people would ask different models: name a family, like "opus" for the newest Opus, or a full id to pin one.',
            'The scribe, played by claude-cli: it names no model: give it one by its full id, as model: "<model id>".',
        ]);
    });

    test("refuses a call whose role nobody plays, or that names no role, rather than picking a model for it", () => {
        const providers = new SlytherProviders();

        expect(providers.ask("x", {}, undefined, { role: "reviewer" })).rejects.toThrow("Nobody plays the reviewer, whose work was asked for.");
        expect(providers.ask("x", {})).rejects.toThrow("The llm was asked without a role: every call names the role it is made for.");
    });
});

describe("ClaudeCLIGenerator options", () => {
    test("takes a full id or the alias of a family, and refuses an alias that depends on whoever runs it", () => {
        expect(ClaudeCLIGenerator.problemsOf({ model: "claude-opus-5", effort: "low" })).toEqual([]);
        expect(ClaudeCLIGenerator.problemsOf({ model: "claude-opus-5[1m]" })).toEqual([]);
        expect(ClaudeCLIGenerator.problemsOf({ model: "opus[1m]" })).toEqual([]);
        expect(ClaudeCLIGenerator.problemsOf({ model: "Sonnet" })).toEqual([]);
        expect(ClaudeCLIGenerator.problemsOf({ model: "default" })).toHaveLength(1);
        expect(ClaudeCLIGenerator.problemsOf({ model: "opusplan" })).toHaveLength(1);
    });

    test("an alias resolves to the model of its family the reply used, keeping the context window it asks for", () => {
        expect(ClaudeCLIGenerator.resolvedIn("opus", ["claude-haiku-4-5-20251001", "claude-opus-5"])).toBe("claude-opus-5");
        expect(ClaudeCLIGenerator.resolvedIn("opus[1m]", ["claude-haiku-4-5-20251001", "claude-opus-5"])).toBe("claude-opus-5[1m]");
        expect(ClaudeCLIGenerator.resolvedIn("opus[1m]", ["claude-opus-5[1m]"])).toBe("claude-opus-5[1m]");
        expect(ClaudeCLIGenerator.resolvedIn("haiku", ["claude-haiku-4-5-20251001"])).toBe("claude-haiku-4-5-20251001");
        expect(() => ClaudeCLIGenerator.resolvedIn("sonnet", ["claude-haiku-4-5-20251001"])).toThrow(
            'Could not tell which model "sonnet" resolves to: the Claude CLI used claude-haiku-4-5-20251001. Name the model by its full id instead.',
        );
    });
});
