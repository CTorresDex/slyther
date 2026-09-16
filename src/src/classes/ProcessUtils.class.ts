// Imports

export class ProcessUtils {
    /**
     * Runs the command and waits for it to exit. A command that cannot be spawned does not throw: it
     * exits with 127 and the reason as its stderr, so a caller treats it like any other failure.
     */
    static async run(
        command: string[],
        options: { cwd?: string; stdin?: string } = {},
    ): Promise<{ code: number; stdout: string; stderr: string }> {
        let process: ReturnType<typeof Bun.spawn>;

        try {
            process = Bun.spawn(command, {
                cwd: options.cwd,
                stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
                stdout: "pipe",
                stderr: "pipe",
            });
        } catch (error) {
            return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
        }

        const [stdout, stderr, code] = await Promise.all([
            new Response(process.stdout as ReadableStream).text(),
            new Response(process.stderr as ReadableStream).text(),
            process.exited,
        ]);

        return { code, stdout, stderr };
    }
}
