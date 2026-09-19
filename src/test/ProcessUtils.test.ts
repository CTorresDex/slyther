import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessUtils } from "../src/classes/ProcessUtils.class.ts";

let root = "";
const write = async (name: string, content: string) => {
    const path = join(root, name);

    await writeFile(path, content);

    return path;
};
/** Whether the process is still there, which is what a killed group must not leave behind. */
const alive = (pid: number) => {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "slyther-process-"));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("ProcessUtils", () => {
    test("returns the exit code, the stdout and the stderr of a command", async () => {
        const result = await ProcessUtils.run(["sh", "-c", "echo out; echo err >&2; exit 3"]);

        expect(result.code).toBe(3);
        expect(result.stdout.trim()).toBe("out");
        expect(result.stderr.trim()).toBe("err");
    });

    test("hands the text it is given over stdin", async () => {
        expect((await ProcessUtils.run(["cat"], { stdin: "hello" })).stdout).toBe("hello");
    });

    test("a command that cannot be spawned exits 127 with the reason", async () => {
        const result = await ProcessUtils.run([join(root, "there-is-no-such-command")]);

        expect(result.code).toBe(127);
        expect(result.stderr).not.toBe("");
    });

    test("what the command spawned does not outlive it, even when it holds its output", async () => {
        const pidfile = join(root, "left-behind.pid");
        // The command waits until what it spawned says it is there, so it is really left behind and not merely late.
        const script = await write(
            "leaves.sh",
            `sh -c 'echo $$ > ${pidfile}; sleep 60' &\nwhile [ ! -s ${pidfile} ]; do sleep 0.05; done\necho done\n`,
        );
        const result = await ProcessUtils.run(["sh", script]);

        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe("done");

        await settle();
        expect(alive(Number((await readFile(pidfile, "utf-8")).trim()))).toBe(false);
    });

    test("a command that outruns its timeout is killed, with everything it spawned", async () => {
        const pidfile = join(root, "timed-out.pid");
        const script = await write("hangs.sh", `sh -c 'echo $$ > ${pidfile}; sleep 60' &\nwhile [ ! -s ${pidfile} ]; do sleep 0.05; done\nsleep 60\n`);
        const result = await ProcessUtils.run(["sh", script], { timeout: 500 });

        expect(result.code).toBe(ProcessUtils.TIMED_OUT);
        expect(result.stderr).toContain("did not finish");

        await settle();
        expect(alive(Number((await readFile(pidfile, "utf-8")).trim()))).toBe(false);
    });

    test("a command that finishes within its timeout keeps its own exit code", async () => {
        expect((await ProcessUtils.run(["sh", "-c", "exit 1"], { timeout: 10_000 })).code).toBe(1);
    });
});
