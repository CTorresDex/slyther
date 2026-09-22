import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherGenerator } from "../src/classes/SlytherGenerator.class.ts";
import { SlytherProject } from "../src/classes/SlytherProject.class.ts";

/** Builds the sh scripts registered for every path and passes every judgement; nothing here ever writes code. */
class FakeGenerator extends SlytherGenerator {
    constructor(readonly scripts: Record<string, string>) {
        super();
    }

    override async ask<T>(prompt: string): Promise<{ result: T; session: string }> {
        if (prompt.includes("Reply with `pass`")) {
            return { result: { pass: true, errors: [] } as T, session: "s" };
        }

        const path = /`([^`]+)` in sh/.exec(prompt)![1]!;

        return { result: { files: [{ path, content: `${this.scripts[path]}\n` }], dependencies: {} } as T, session: "s" };
    }

    override async execute(): Promise<{ text: string; session: string }> {
        return { text: "", session: "e" };
    }
}

const SCRIPTS = {
    "k/locate/locate.sh": '[ -f "src/$1.txt" ] && echo "src/$1.txt" && exit 0; exit 1',
    "k/list/list.sh": 'ls src/*.txt 2>/dev/null | sed "s|src/||; s|\\.txt$||"',
    "k/evaluate/k.fine.sh": "exit 0",
};
const SPEC = (adopts = "rule #{Errors}") => `@lang "sh"
@trait Errors {
    asset errors ref "./lib/errors.txt" to "src/lib/errors.txt"
    asset fixtures ref "./fixtures/" to "src/fixtures"
    rule usage { raised through the lib }
}
@artifact k {
    ${adopts}
    rule fine: deterministic { always }
    operation locate: deterministic { prints src/{id}.txt }
}
k A { the a }`;

let root = "";
const code = () => join(root, SlytherProject.OUTPUT, SlytherProject.SOURCE);
const project = () => new SlytherProject(root, new FakeGenerator(SCRIPTS));
const statuses = (report: { key: string; status: string; reason?: string }[]) =>
    report.filter((entry) => entry.key.startsWith("asset:")).map((entry) => `${entry.key} ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}`);
const copied = () => readFile(join(code(), "src/lib/errors.txt"), "utf-8").catch(() => undefined);

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "slyther-assets-"));
    await mkdir(join(code(), "src"), { recursive: true });
    await mkdir(join(root, "lib"));
    await mkdir(join(root, "fixtures", "deep"), { recursive: true });
    await writeFile(join(root, "main.sly"), SPEC());
    await writeFile(join(root, "lib", "errors.txt"), "v1\n");
    await writeFile(join(root, "fixtures", "deep", "a.txt"), "a\n");
    await writeFile(join(code(), "src", "A.txt"), "a\n");
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("SlytherInstanceChecker assets", () => {
    test("an asset of an adopted trait is missing until a build copies it, then kept", async () => {
        expect(statuses(await project().check())).toEqual(["asset:Errors::errors missing (missing)", "asset:Errors::fixtures missing (missing)"]);
        expect(await copied()).toBeUndefined();

        expect(statuses((await project().build()).instances)).toEqual(["asset:Errors::errors created (missing)", "asset:Errors::fixtures created (missing)"]);
        expect(await copied()).toBe("v1\n");
        expect(await readFile(join(code(), "src/fixtures/deep/a.txt"), "utf-8")).toBe("a\n");
        expect(statuses(await project().check())).toEqual(["asset:Errors::errors kept", "asset:Errors::fixtures kept"]);
    });

    test("a copy that differs fails a check and is put back by a build, whether it was edited or its source changed", async () => {
        await project().build();
        await writeFile(join(code(), "src/lib/errors.txt"), "edited\n");

        const report = await project().check();

        expect(statuses(report)).toEqual(["asset:Errors::errors fail (differs from its source)", "asset:Errors::fixtures kept"]);
        expect(report[0]!.errors).toEqual(["src/lib/errors.txt differs from ../../lib/errors.txt, which it is a copy of: edit the source or drop the asset to make the copy yours"]);
        expect(statuses((await project().build()).instances)).toEqual(["asset:Errors::errors updated (differs from its source)", "asset:Errors::fixtures kept"]);
        expect(await copied()).toBe("v1\n");

        await writeFile(join(root, "lib", "errors.txt"), "v2\n");

        expect(statuses(await project().check())).toEqual(["asset:Errors::errors fail (its source changed)", "asset:Errors::fixtures kept"]);
        expect(statuses((await project().build()).instances)).toEqual(["asset:Errors::errors updated (its source changed)", "asset:Errors::fixtures kept"]);
        expect(await copied()).toBe("v2\n");
    });

    test("an asset of a trait nobody adopts is not wanted, and one declared outside any trait always is", async () => {
        await writeFile(join(root, "main.sly"), `${SPEC("")}\nasset own ref "./lib/errors.txt" to "src/own.txt"`);

        expect(statuses((await project().build()).instances)).toEqual(["asset:own created (missing)"]);
        expect(await copied()).toBeUndefined();
    });
});
