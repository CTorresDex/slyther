// Imports

export class StringUtils {
    /** The lines without the indentation they share and without the blank lines around them. */
    static dedent(lines: string[]): string {
        const indent = Math.min(
            ...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
        );

        return lines
            .map((line) => (line.trim() ? line.slice(indent) : ""))
            .join("\n")
            .trim();
    }

    /** A span of milliseconds as people read it: `800ms`, `42s` or `2m10s`. */
    static duration(milliseconds: number): string {
        const seconds = Math.round(milliseconds / 1000);

        if (seconds < 1) return `${Math.round(milliseconds)}ms`;
        if (seconds < 60) return `${seconds}s`;

        return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
    }

    /**
     * Splits the text on every separator that falls outside a quoted run, keeping the quotes, and
     * drops the entries that hold nothing but whitespace.
     */
    static splitUnquoted(text: string, separator: string): string[] {
        const entries: string[] = [];
        let current = "";
        let quote = "";

        for (const character of text) {
            if (quote) {
                current += character;
                quote = character === quote ? "" : quote;
                continue;
            }

            if (character === '"' || character === "'") {
                quote = character;
            } else if (character === separator) {
                entries.push(current);
                current = "";
                continue;
            }

            current += character;
        }

        entries.push(current);

        return entries.filter((entry) => entry.trim().length > 0);
    }
}
