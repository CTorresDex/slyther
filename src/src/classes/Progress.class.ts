// Imports

export class Progress {
    /** The frames of the animation, in the order they are drawn. */
    private static readonly FRAMES = ["|", "/", "-", "\\"];
    /** How long each frame stays on screen. */
    private static readonly INTERVAL = 80;
    /** Returns the cursor to the start of the line and clears it. */
    private static readonly CLEAR = "\r[2K";

    private timer: ReturnType<typeof setInterval> | null = null;
    private frame = 0;

    private constructor(private label: string) {}

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

    /** Changes what the indicator says it is waiting on. */
    say(label: string): void {
        this.label = label;
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

        this.erase();
        process.stderr.write(`${Progress.FRAMES[this.frame]} ${this.label}`);
    }

    private erase(): void {
        if (!process.stderr.isTTY) {
            return;
        }

        process.stderr.write(Progress.CLEAR);
    }
}
