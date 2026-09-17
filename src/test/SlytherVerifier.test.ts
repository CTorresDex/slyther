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

    test("locate must find the first id list prints", async () => {
        const locate = { script: await write("locate.sh", '[ "$1" = "a" ] && echo src/a.ts && exit 0; exit 1\n'), runtime };
        const ok = await write("list-ok.sh", "echo a\n");
        const bad = await write("list-mismatch.sh", "echo b\n");
        const empty = await write("list-empty.sh", "true\n");
        const verifier = new SlytherVerifier(root);

        expect(await verifier.verify({ operation: "list", script: ok, runtime, locate })).toBeNull();
        expect(await verifier.verify({ operation: "list", script: empty, runtime, locate })).toBeNull();
        expect(await verifier.verify({ operation: "list", script: bad, runtime, locate })).toBe(
            'list-mismatch.sh printed the id "b" but locate.sh does not find it: list must print the ids locate takes.',
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
