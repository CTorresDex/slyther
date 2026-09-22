// Imports
import { StringUtils } from "./StringUtils.class.ts";

export class Progress {
    /** The frames of the animation, in the order they are drawn. */
    private static readonly FRAMES = ["|", "/", "-", "\\"];
    /** How long each frame stays on screen. */
    private static readonly INTERVAL = 80;
    /** Returns the cursor to the start of the line and clears it. */
    private static readonly CLEAR = "\r[2K";

    /** How long a wait is before the indicator starts saying how long it has been. */
    private static readonly PATIENCE = 10_000;

    private timer: ReturnType<typeof setInterval> | null = null;
    private frame = 0;
    /** When the current label was set, so a long wait shows its duration. */
    private since = Date.now();

    private constructor(private label: string | (() => string)) {}

    /** An indicator for the work the label names. Nothing is drawn until it is run. */
    static of(label: string): Progress {
        return new Progress(label);
    }

    /** Runs the work while the indicator animates, and erases the animation once the work settles. */
    async run<T>(work: (progress: Progress) => T | Promise<T>): Promise<T> {
        this.start();

        try {
            return await work(this);
        } finally {
            this.stop();
        }
    }

    /**
     * Changes what the indicator says it is waiting on: a label, or what gives the label each time it is
     * drawn, which then says for itself how long it has waited.
     */
    say(label: string | (() => string)): void {
        this.label = label;
        this.since = Date.now();
        this.draw();
    }

    /** Prints a finished line above the animation, so the work can report as it goes. */
    log(line: string): void {
        this.erase();
        process.stderr.write(`${line}\n`);
        this.draw();
    }

    private start(): void {
        if (this.timer || !process.stderr.isTTY) {
            return;
        }

        this.draw();

        this.timer = setInterval(() => {
            this.frame = (this.frame + 1) % Progress.FRAMES.length;
            this.draw();
        }, Progress.INTERVAL);
        this.timer.unref?.();
    }

    private stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        this.erase();
    }

    private draw(): void {
        if (!process.stderr.isTTY) {
            return;
        }

        const waited = Date.now() - this.since;
        const line =
            typeof this.label === "function"
                ? `${Progress.FRAMES[this.frame]} ${this.label()}`
                : `${Progress.FRAMES[this.frame]} ${this.label}${waited >= Progress.PATIENCE ? ` · ${StringUtils.duration(waited)}` : ""}`;
        // A line wider than the terminal wraps, and clearing it would then leave the wrapped part behind.
        const width = Math.max((process.stderr.columns ?? 80) - 1, 1);

        this.erase();
        process.stderr.write(line.length > width ? `${line.slice(0, width - 1)}…` : line);
    }

    private erase(): void {
        if (!process.stderr.isTTY) {
            return;
        }

        process.stderr.write(Progress.CLEAR);
    }
}
