import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherRuntime } from "../src/classes/SlytherRuntime.class.ts";
import { SlytherVerifier } from "../src/classes/SlytherVerifier.class.ts";

let root = "";
const runtime = SlytherRuntime.of("sh", ".slyther/artifacts");
const write = async (name: string, content: string) => {
    await writeFile(join(root, name), content);

    return name;
};

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "slyther-verifier-"));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("SlytherVerifier", () => {
    test("a script that does not parse fails the syntax check", async () => {
        const script = await write("bad.sh", "if [ ; then\n");

        expect(await new SlytherVerifier(root).verify({ operation: "create", script, runtime })).toStartWith(
            "bad.sh does not pass the syntax check:",
        );
    });

    test("a script of an operation that is not read-only is only checked for syntax", async () => {
        const script = await write("create.sh", "exit 3\n");

        expect(await new SlytherVerifier(root).verify({ operation: "create", script, runtime })).toBeNull();
    });

    test("list must exit 0", async () => {
        const ok = await write("list.sh", "echo a\necho b\n");
        const bad = await write("list-bad.sh", "exit 2\n");
        const verifier = new SlytherVerifier(root);

        expect(await verifier.verify({ operation: "list", script: ok, runtime })).toBeNull();
        expect(await verifier.verify({ operation: "list", script: bad, runtime })).toStartWith("list-bad.sh must exit 0 but exited 2");
    });

    test("a script that does not finish is killed, with everything it spawned, and fails", async () => {
        // A script that runs one that runs it back never returns: it is killed instead of multiplying behind the build.
        const script = await write("hangs.sh", "sleep 60\n");
        const failure = await new SlytherVerifier(root, 500).verify({ operation: "list", script, runtime });

        expect(failure).toContain("did not finish in 500ms and was killed");
        expect(failure).toContain("it must never run a script that runs it back");
    });

    test("locate must find the first id list prints", async () => {
        const locate = { script: await write("locate.sh", '[ "$1" = "a" ] && echo src/a.ts && exit 0; exit 1\n'), runtime };
        const ok = await write("list-ok.sh", "echo a\n");
        const bad = await write("list-mismatch.sh", "echo b\n");
        const empty = await write("list-empty.sh", "true\n");
        const verifier = new SlytherVerifier(root);

        expect(await verifier.verify({ operation: "list", script: ok, runtime, locate })).toBeNull();
        expect(await verifier.verify({ operation: "list", script: empty, runtime, locate })).toBeNull();
        expect(await verifier.verify({ operation: "list", script: bad, runtime, locate })).toBe(
            'list-mismatch.sh printed the id "b" but locate.sh does not find it given "b": list must print the ids locate takes, and locate must read them as they are given.',
        );
    });

    test("locate runs with the first id list prints and must exit 0 or 1", async () => {
        const list = { script: await write("list.sh", "echo a\necho b\n"), runtime };
        const ok = await write("locate.sh", '[ "$1" = "a" ] && echo src/a.ts && exit 0; exit 1\n');
        const crash = await write("locate-crash.sh", "exit 2\n");
        const noisy = await write("locate-noisy.sh", "echo oops; exit 1\n");
        const verifier = new SlytherVerifier(root);

        expect(await verifier.verify({ operation: "locate", script: ok, runtime, list })).toBeNull();
        expect(await verifier.verify({ operation: "locate", script: crash, runtime, list })).toStartWith(
            'locate-crash.sh must exit 0 or 1 given "a" but exited 2',
        );
        expect(await verifier.verify({ operation: "locate", script: noisy, runtime, list })).toStartWith(
            'locate-noisy.sh must print nothing when it exits 1, but given "a" it printed:',
        );
    });

    test("locate runs with a sample id when there is no list", async () => {
        const script = await write("locate-sample.sh", 'echo "$1" > "$0.id"; exit 1\n');

        expect(await new SlytherVerifier(root).verify({ operation: "locate", script, runtime })).toBeNull();
        expect(await Bun.file(join(root, "locate-sample.sh.id")).text()).toBe("sample\n");
    });

    test("signature must print key shape lines", async () => {
        const list = { script: await write("list.sh", "echo a\n"), runtime };
        const ok = await write("signature.sh", "echo 'name string'\necho 'greet (): string'\n");
        const bad = await write("signature-bad.sh", "echo 'name'\n");
        const verifier = new SlytherVerifier(root);

        expect(await verifier.verify({ operation: "signature", script: ok, runtime, list })).toBeNull();
        expect(await verifier.verify({ operation: "signature", script: bad, runtime, list })).toBe(
            'signature-bad.sh printed a line that is not `key shape` given "a":\nname',
        );
    });

    test("signature and uses must exit 0 for an id list prints, and may exit 1 for the sample", async () => {
        const list = { script: await write("list.sh", "echo a\n"), runtime };
        const missing = await write("signature-missing.sh", "echo 'not found' >&2; exit 1\n");
        const verifier = new SlytherVerifier(root);

        expect(await verifier.verify({ operation: "signature", script: missing, runtime, list })).toBe(
            'signature-missing.sh must exit 0 given "a", which list prints so it exists, but exited 1:\nnot found\n',
        );
        expect(await verifier.verify({ operation: "uses", script: missing, runtime, list })).toStartWith('signature-missing.sh must exit 0 given "a"');
        expect(await verifier.verify({ operation: "signature", script: missing, runtime })).toBeNull();
    });

    test("uses must print kind:id key lines", async () => {
        const ok = await write("uses.sh", "echo 'class:User name'\necho 'class:Logger *'\necho 'class:Form **'\n");
        const bad = await write("uses-bad.sh", "echo 'User name'\n");
        const verifier = new SlytherVerifier(root);

        expect(await verifier.verify({ operation: "uses", script: ok, runtime })).toBeNull();
        expect(await verifier.verify({ operation: "uses", script: bad, runtime })).toBe(
            'uses-bad.sh printed a line that is not `kind:id key` given "sample":\nUser name',
        );
    });
});

describe("SlytherVerifier expand", () => {
    test("expand runs with the sample args, must exit 0, and what it prints must be accepted", async () => {
        const ok = await write("expand.sh", 'echo "k one { of $1 and $2 }"\n');
        const failing = await write("expand-fail.sh", "echo nope >&2; exit 2\n");
        const verifier = new SlytherVerifier(root);
        const validate = (output: string) => (output.includes("of sample and sample") ? null : `unexpected: ${output.trim()}`);

        expect(await verifier.verify({ operation: "expand", script: ok, runtime, expand: { args: ["sample", "sample"], validate } })).toBeNull();
        expect(await verifier.verify({ operation: "expand", script: ok, runtime, expand: { args: ["other", "other"], validate } })).toBe(
            "expand.sh printed declarations that are not accepted:\nunexpected: k one { of other and other }",
        );
        expect(await verifier.verify({ operation: "expand", script: failing, runtime, expand: { args: ["sample"], validate } })).toBe(
            'expand-fail.sh must exit 0 given "sample" but exited 2:\nnope\n',
        );
    });
});

describe("SlytherVerifier with the args of a declared instance", () => {
    // A research at research/doc.md: list prints "doc", and its instance runs locate with "doc" "research/doc.md".
    const argsOf = (operation: string, id: string) => (id === "doc" ? [id, "research/doc.md"] : undefined);

    beforeAll(async () => {
        await Bun.write(join(root, "research", "doc.md"), "the doc");
    });

    test("a locate that reads the wrong arg fails, though a sample would have passed it", async () => {
        const list = { script: await write("research-list.sh", "echo doc\n"), runtime };
        // Takes the path from $1, the id, instead of $2.
        const script = await write("research-locate-wrong.sh", '[ -f "$1" ] && echo "$1" && exit 0\nexit 1\n');

        expect(await new SlytherVerifier(root).verify({ operation: "locate", script, runtime, params: 2, list })).toBeNull();
        expect(await new SlytherVerifier(root).verify({ operation: "locate", script, runtime, params: 2, list, argsOf })).toStartWith(
            'research-locate-wrong.sh must exit 0 given "doc" "research/doc.md", the args of "doc", which list prints so it exists, but exited 1',
        );
    });

    test("a locate that asks for an arg it is never given fails", async () => {
        const list = { script: await write("server-list.sh", "echo doc\n"), runtime };
        // The operation gives the id alone, but the script wants a second one.
        const script = await write("server-locate.sh", '[ -z "$2" ] && echo "usage: <id> <language>" >&2 && exit 1\necho "$1"\n');
        const idOnly = (operation: string, id: string) => [id];

        expect(await new SlytherVerifier(root).verify({ operation: "locate", script, runtime, params: 1, list, argsOf: idOnly })).toStartWith(
            'server-locate.sh must exit 0 given "doc", the args of "doc"',
        );
    });

    test("a locate that reads its args as given passes", async () => {
        const list = { script: await write("research-list-ok.sh", "echo doc\n"), runtime };
        const script = await write("research-locate-ok.sh", '[ -f "$2" ] && echo "$2" && exit 0\nexit 1\n');

        expect(await new SlytherVerifier(root).verify({ operation: "locate", script, runtime, params: 2, list, argsOf })).toBeNull();
    });

    test("list runs locate with the args of the instance of the id it prints", async () => {
        const list = await write("research-list-check.sh", "echo doc\n");
        const wrong = { script: await write("research-locate-wrong-2.sh", '[ -f "$1" ] && echo "$1" && exit 0\nexit 1\n'), runtime };
        const right = { script: await write("research-locate-right.sh", '[ -f "$2" ] && echo "$2" && exit 0\nexit 1\n'), runtime };

        expect(await new SlytherVerifier(root).verify({ operation: "list", script: list, runtime, locate: right, argsOf })).toBeNull();
        expect(await new SlytherVerifier(root).verify({ operation: "list", script: list, runtime, locate: wrong, argsOf })).toStartWith(
            'research-list-check.sh printed the id "doc" but research-locate-wrong-2.sh does not find it given "doc" "research/doc.md"',
        );
    });

    test("an id no instance declares is run with samples, and may be missing", async () => {
        const list = { script: await write("orphan-list.sh", "echo orphan\n"), runtime };
        const script = await write("orphan-locate.sh", '[ -f "$2" ] && echo "$2" && exit 0\nexit 1\n');

        expect(await new SlytherVerifier(root).verify({ operation: "locate", script, runtime, params: 2, list, argsOf })).toBeNull();
    });
});
