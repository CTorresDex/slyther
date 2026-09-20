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

    /**
     * The two texts as a line diff: `- ` what only the first holds, `+ ` what only the second holds,
     * and `  ` what both hold, with every run of unchanged lines farther than the context from a change
     * collapsed into a single `  ...`. Empty when the texts are the same.
     */
    static diff(before: string, after: string, context = 3): string[] {
        if (before === after) {
            return [];
        }

        const from = before.split("\n");
        const to = after.split("\n");
        const common: number[][] = Array.from({ length: from.length + 1 }, () => new Array<number>(to.length + 1).fill(0));

        for (let line = from.length - 1; line >= 0; line--) {
            for (let other = to.length - 1; other >= 0; other--) {
                common[line]![other] =
                    from[line] === to[other] ? common[line + 1]![other + 1]! + 1 : Math.max(common[line + 1]![other]!, common[line]![other + 1]!);
            }
        }

        const lines: string[] = [];
        let line = 0;
        let other = 0;

        while (line < from.length && other < to.length) {
            if (from[line] === to[other]) {
                lines.push(`  ${from[line]}`);
                line += 1;
                other += 1;
            } else if (common[line + 1]![other]! >= common[line]![other + 1]!) {
                lines.push(`- ${from[line]}`);
                line += 1;
            } else {
                lines.push(`+ ${to[other]}`);
                other += 1;
            }
        }

        for (; line < from.length; line++) {
            lines.push(`- ${from[line]}`);
        }

        for (; other < to.length; other++) {
            lines.push(`+ ${to[other]}`);
        }

        return StringUtils.around(lines, context);
    }

    /** The diff lines within the context of a change, every longer run of unchanged ones standing as one `  ...`. */
    private static around(lines: string[], context: number): string[] {
        const near = lines.map((_, index) => lines.some((line, at) => !line.startsWith("  ") && Math.abs(at - index) <= context));
        const kept: string[] = [];

        for (const [index, line] of lines.entries()) {
            if (near[index]) {
                kept.push(line);
            } else if (near[index - 1] ?? true) {
                kept.push("  ...");
            }
        }

        return kept;
    }
}
