import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherGenerator } from "../src/classes/SlytherGenerator.class.ts";
import { SlytherProject } from "../src/classes/SlytherProject.class.ts";

/** Builds the sh scripts registered for every path, and answers every llm evaluation as told. */
class FakeGenerator extends SlytherGenerator {
    readonly evaluated: string[] = [];
    readonly prompts: string[] = [];

    constructor(
        readonly scripts: Record<string, string>,
        readonly verdict: { pass: boolean; errors: string[] } = { pass: true, errors: [] },
    ) {
        super();
    }

    override async ask<T>(prompt: string): Promise<{ result: T; session: string }> {
        this.prompts.push(prompt);

        if (prompt.includes("Reply with `pass`")) {
            this.evaluated.push(/to evaluate: (\S+)/.exec(prompt)![1]!);

            return { result: this.verdict as T, session: "s" };
        }

        const path = /`([^`]+)`\.$/m.exec(prompt)![1]!;

        return { result: { files: [{ path, content: `${this.scripts[path]}\n` }], dependencies: {} } as T, session: "s" };
    }

    override async execute(): Promise<string> {
        return "";
    }
}

/**
 * A service is `src/<id>.txt`; what it uses is `src/<id>.uses`, which its create copies from the
 * `src/<id>.wants` the test seeds, so what a service asks for is only known once it has been written.
 * A util is `src/util-<id>.txt`, and what is written in it is what was asked of it.
 */
const SCRIPTS = {
    "svc/locate/locate.sh": '[ -f "src/$1.txt" ] || exit 1; echo "src/$1.txt"',
    "svc/list/list.sh": 'ls src/*.txt 2>/dev/null | grep -v "/util-" | sed "s|src/||; s|\\.txt$||"',
    "svc/signature/signature.sh": '[ -f "src/$1.txt" ] || exit 1; echo "run (): void"',
    "svc/uses/uses.sh": '[ -f "src/$1.txt" ] || exit 1; [ -f "src/$1.uses" ] && cat "src/$1.uses"; exit 0',
    "svc/create/make.sh": 'printf "%s\\n" "$2" > "src/$1.txt"; [ -f "src/$1.wants" ] && cp "src/$1.wants" "src/$1.uses"; exit 0',
    "svc/update/fix.sh": '[ -f "src/$1.wants" ] && cp "src/$1.wants" "src/$1.uses"; exit 0',
    "svc/evaluate/check.sh": "exit 0",
    "util/locate/locate.sh": '[ -f "src/util-$1.txt" ] || exit 1; echo "src/util-$1.txt"',
    "util/list/list.sh": 'ls src/util-*.txt 2>/dev/null | sed "s|src/util-||; s|\\.txt$||"',
    "util/signature/signature.sh": '[ -f "src/util-$1.txt" ] || exit 1; sed "s/ (.*//; s/$/ (): string/" "src/util-$1.txt"',
    "util/uses/uses.sh": '[ -f "src/util-$1.txt" ] || exit 1; exit 0',
    "util/create/make.sh": 'printf "%s\\n" "$2" > "src/util-$1.txt"',
    "util/update/fix.sh": 'printf "%s\\n" "$2" > "src/util-$1.txt"',
    "util/evaluate/check.sh": "exit 0",
};

const SPEC = (instances: string) => `@lang "sh"
@artifact util: demanded {
    rules of util
    operation locate: deterministic { prints src/util-{id}.txt }
    operation create: deterministic {
        deterministic make { writes what is asked of it }
    }
    operation update: deterministic {
        deterministic fix { rewrites what is asked of it }
    }
    operation evaluate: deterministic {
        deterministic check { always passes }
    }
}
@artifact svc (requirements: string) {
    rules of svc, whose utilities live in a #{util}
    operation locate: deterministic { prints src/{id}.txt }
    operation create: deterministic {
        deterministic make { writes the requirements }
    }
    operation update: deterministic {
        deterministic fix { rewrites it }
    }
    operation evaluate: deterministic {
        deterministic check { always passes }
    }
}
${instances}`;

let root = "";
const code = () => join(root, SlytherProject.OUTPUT, SlytherProject.SOURCE, "src");
const write = (name: string, content: string) => writeFile(join(code(), name), content);
const read = (name: string) => readFile(join(code(), name), "utf-8");
const spec = (instances: string) => writeFile(join(root, "main.sly"), SPEC(instances));
const compile = async (generator = new FakeGenerator(SCRIPTS)) => (await new SlytherProject(root, generator).build()).instances;
const statuses = (report: { key: string; status: string; reason?: string }[]) => report.map((entry) => `${entry.key} ${entry.status}`);
const manifest = async () => JSON.parse(await readFile(join(root, ".slyther/instances/manifest.json"), "utf-8")).instances;
const demanded = (name: string) => readFile(join(root, ".slyther/instances/demanded/util", `${name}.sly`), "utf-8");

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "slyther-demanded-"));
    await mkdir(code(), { recursive: true });
    await spec("svc A { the a }");
    await write("A.wants", "util:StringUtils capitalize\n");
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("a demanded kind", () => {
    test("creates the instance nothing declares, once what asks for it has been written", async () => {
        const report = await compile();

        expect(statuses(report)).toEqual(["util:StringUtils created", "svc:A created"]);
        expect(await read("util-StringUtils.txt")).toBe("capitalize (svc:A)\n");
    });

    test("records what asks for it, and what it is asked", async () => {
        await compile();

        expect((await manifest())["util:StringUtils"]).toMatchObject({
            demandedBy: ["svc:A"],
            demands: "capitalize (svc:A)",
            result: "pass",
        });
    });

    test("writes what is asked of it next to the manifest, so the graph it grows is reviewed", async () => {
        await compile();

        expect(await demanded("StringUtils")).toBe(
            "util StringUtils {\n    What the artifacts that use it ask of it, and nothing more:\n\n    capitalize (svc:A)\n}\n",
        );
    });

    test("is asked for by everything that uses it, not only by the first", async () => {
        await compile();
        await spec("svc A { the a }\nsvc B { the b }");
        await write("B.wants", "util:StringUtils slugify\n");

        const report = await compile();

        expect(statuses(report)).toContain("util:StringUtils updated");
        expect(await read("util-StringUtils.txt")).toBe("capitalize (svc:A)\nslugify (svc:B)\n");
        expect((await manifest())["util:StringUtils"]!.demandedBy).toEqual(["svc:A", "svc:B"]);
    });

    test("loses what is no longer asked of it", async () => {
        await compile();
        await spec("svc A { the a, changed }");
        await write("A.wants", "util:StringUtils slugify\n");

        await compile();

        expect(await read("util-StringUtils.txt")).toBe("slugify (svc:A)\n");
    });

    test("is an orphan once nothing asks for it at all", async () => {
        await compile();
        await spec("svc A { the a, changed }");
        await write("A.wants", "");

        const report = await compile();

        expect(report.find((entry) => entry.key === "util:StringUtils")).toMatchObject({
            status: "orphan",
            reason: "nothing asks for it any more",
        });
    });

    test("stays an orphan on the checks after the one that noticed, without failing what used to ask", async () => {
        await compile();
        await spec("svc A { the a, changed }");
        await write("A.wants", "");
        await compile();

        const report = await compile();

        expect(report.find((entry) => entry.key === "util:StringUtils")).toMatchObject({ status: "orphan" });
        expect(report.find((entry) => entry.key === "svc:A")!.status).not.toBe("fail");
    });

    test("adds what is asked of one declared by hand to what it declares, rather than replacing it", async () => {
        await spec("util StringUtils { it holds the string helpers }\nsvc A { the a }");

        const report = await compile();
        const record = (await manifest())["util:StringUtils"]!;

        expect(report.find((entry) => entry.key === "util:StringUtils")!.status).toBe("created");
        expect(record.demands).toBe("capitalize (svc:A)");
        expect(record.spec).toContain("it holds the string helpers");
        expect(record.spec).toContain("capitalize (svc:A)");
    });

    test("leaves one declared by hand alone when nothing asks for it any more", async () => {
        await spec("util StringUtils { it holds the string helpers }\nsvc A { the a }");
        await compile();
        await spec("util StringUtils { it holds the string helpers }\nsvc A { the a, changed }");
        await write("A.wants", "");

        const report = await compile();

        expect(report.find((entry) => entry.key === "util:StringUtils")!.status).not.toBe("orphan");
    });

    test("tells whoever writes for it what its demands hold, since nothing declares its instances", async () => {
        const generator = new FakeGenerator(SCRIPTS);

        await compile(generator);

        const written = generator.prompts.filter((prompt) => prompt.includes("util/create"));

        expect(written).not.toBeEmpty();
        expect(written.every((prompt) => prompt.includes('The param "demands" is what those artifacts ask of it'))).toBe(true);
        expect(generator.prompts.some((prompt) => prompt.includes("svc/create") && prompt.includes('The param "demands"'))).toBe(false);
    });

    test("is not warned about for existing without a declaration", async () => {
        const lines: string[] = [];

        await compile();
        await new SlytherProject(root, new FakeGenerator(SCRIPTS), { log: (line: string) => lines.push(line), say: () => {} }).build();

        expect(lines.filter((line) => line.includes("warning"))).toEqual([]);
    });
});
