// Imports
import { spawn } from "node:child_process";

export class ProcessUtils {
    /** The code a command that outran its timeout exits with, so a caller tells it apart from one the command chose. */
    static readonly TIMED_OUT = 124;
    /** How long whatever the command left behind is given to let go of its output before the result is returned. */
    private static readonly GRACE = 1_000;

    /**
     * Runs the command and waits for it to exit, with whatever variables it is given added to the
     * environment. A command that cannot be spawned does not throw: it
     * exits with 127 and the reason as its stderr, so a caller treats it like any other failure.
     *
     * The command runs in a process group of its own, killed whole once it exits and once it outruns
     * the timeout it is given, so nothing it spawned outlives it: a script that spawns another, which
     * spawns it back, dies with the command instead of multiplying behind it. A command that outruns
     * its timeout exits with #{TIMED_OUT}, and one given none is waited on for as long as it runs.
     */
    static async run(
        command: string[],
        options: { cwd?: string; stdin?: string; timeout?: number; env?: Record<string, string> } = {},
    ): Promise<{ code: number; stdout: string; stderr: string }> {
        return new Promise((resolve) => {
            let child;

            try {
                child = spawn(command[0]!, command.slice(1), {
                    cwd: options.cwd,
                    detached: true,
                    stdio: ["pipe", "pipe", "pipe"],
                    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
                });
            } catch (error) {
                resolve({ code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) });

                return;
            }

            const group = child.pid;
            let stdout = "";
            let stderr = "";
            let exit: { code: number; timedOut: boolean } | undefined;
            let open = 2;
            let done = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let grace: ReturnType<typeof setTimeout> | undefined;

            /** Returns the result once the command exited and nothing holds its output anymore. */
            const finish = () => {
                if (done || exit === undefined || open > 0) {
                    return;
                }

                done = true;
                clearTimeout(timer);
                clearTimeout(grace);
                resolve({
                    code: exit.timedOut ? ProcessUtils.TIMED_OUT : exit.code,
                    stdout,
                    stderr: exit.timedOut ? `${stderr}the command did not finish in ${options.timeout}ms and was killed` : stderr,
                });
            };

            child.stdout!.on("data", (chunk) => (stdout += chunk));
            child.stderr!.on("data", (chunk) => (stderr += chunk));
            child.stdout!.on("close", () => (open--, finish()));
            child.stderr!.on("close", () => (open--, finish()));
            child.stdin!.on("error", () => undefined);
            child.stdin!.end(options.stdin ?? "");

            if (options.timeout !== undefined) {
                timer = setTimeout(() => {
                    exit = { code: ProcessUtils.TIMED_OUT, timedOut: true };
                    ProcessUtils.kill(group);
                }, options.timeout);
            }

            child.on("error", (error) => {
                exit ??= { code: 127, timedOut: false };
                stderr ||= error.message;
                open = 0;
                finish();
            });

            child.on("exit", (code, signal) => {
                exit ??= { code: code ?? (signal ? 128 : 0), timedOut: false };
                // Whatever the command left behind dies with it, and the output it still holds is waited on no longer than the grace.
                ProcessUtils.kill(group);
                grace = setTimeout(() => ((open = 0), finish()), ProcessUtils.GRACE);
                finish();
            });
        });
    }

    /** Kills the whole process group of a command, so nothing it spawned outlives it. */
    private static kill(group: number | undefined): void {
        if (group === undefined) {
            return;
        }

        try {
            process.kill(-group, "SIGKILL");
        } catch {
            // The group is already gone, which is what killing it is for.
        }
    }
}
