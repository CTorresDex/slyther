// Imports
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

/** A rule read from a `.gitignore`, kept with the folder its patterns are relative to. */
type Rule = { dir: string; negate: boolean; dirOnly: boolean; anchored: boolean; pattern: RegExp };

export class SlytherFolderSource {
    /** Folders never walked into, whatever any `.gitignore` says. */
    private static readonly NEVER = ["node_modules", ".git"];
    /** How much text the files of a folder may hold together before reading them in is refused. */
    private static readonly MAX_TEXT = 1_000_000;
    /** How much of a file is looked at to tell text from binary. */
    private static readonly SNIFF = 8000;

    /**
     * Every file the folder holds, as a path relative to it, sorted, with what each one holds. Folders
     * ignored by a `.gitignore` in the tree are left out, and so are binary files: what they hold is not
     * prose, and their bytes would only make the folder look changed.
     */
    static files(folder: string): { path: string; text: string }[] {
        const found: { path: string; text: string }[] = [];

        SlytherFolderSource.walk(folder, folder, SlytherFolderSource.rulesIn(folder, []), found);

        return found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    }

    /**
     * The hash of everything the folder holds: the path of every file and the hash of what it holds. Adding,
     * removing or renaming a file changes it as much as editing one does, so a folder is as much a source
     * as a file is.
     */
    static hash(folder: string): string {
        const digest = createHash("sha256");

        for (const file of SlytherFolderSource.files(folder)) {
            digest.update(`${file.path}\0${createHash("sha256").update(file.text).digest("hex")}\n`);
        }

        return digest.digest("hex");
    }

    /**
     * Everything the folder holds as one text, each file under a heading naming it, for whoever cannot read
     * files. A folder too big to read in this way must throw an error rather than be cut short, since prose
     * that stops halfway is worse than prose that is missing.
     */
    static text(folder: string): string {
        const sections: string[] = [];
        let size = 0;

        for (const file of SlytherFolderSource.files(folder)) {
            size += file.text.length;

            if (size > SlytherFolderSource.MAX_TEXT) {
                throw new Error(
                    `The folder "${folder}" holds more than ${SlytherFolderSource.MAX_TEXT} characters, too much to read in as prose. Point at a smaller folder, or at a file.`,
                );
            }

            sections.push(`=== ${file.path.split(sep).join("/")} ===\n\n${file.text.trim()}`);
        }

        return sections.join("\n\n");
    }

    /** Walks the folder, collecting the files it holds and the rules each folder in it adds. */
    private static walk(folder: string, root: string, rules: Rule[], found: { path: string; text: string }[]): void {
        for (const entry of readdirSync(folder, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
            const path = join(folder, entry.name);
            const directory = entry.isDirectory();

            if (directory && SlytherFolderSource.NEVER.includes(entry.name)) {
                continue;
            }

            if (SlytherFolderSource.ignored(path, directory, rules)) {
                continue;
            }

            if (directory) {
                SlytherFolderSource.walk(path, root, SlytherFolderSource.rulesIn(path, rules), found);

                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const bytes = readFileSync(path);

            if (bytes.subarray(0, SlytherFolderSource.SNIFF).includes(0)) {
                continue;
            }

            found.push({ path: relative(root, path), text: bytes.toString("utf-8") });
        }
    }

    /** The rules in effect inside a folder: the ones it inherits and the ones its own `.gitignore` adds. */
    private static rulesIn(folder: string, inherited: Rule[]): Rule[] {
        let text: string;

        try {
            text = readFileSync(join(folder, ".gitignore"), "utf-8");
        } catch {
            return inherited;
        }

        const added: Rule[] = [];

        for (const line of text.split("\n")) {
            const trimmed = line.trim();

            if (trimmed.length === 0 || trimmed.startsWith("#")) {
                continue;
            }

            const negate = trimmed.startsWith("!");
            let pattern = negate ? trimmed.slice(1) : trimmed;
            const dirOnly = pattern.endsWith("/");

            pattern = dirOnly ? pattern.slice(0, -1) : pattern;

            const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");

            added.push({ dir: folder, negate, dirOnly, anchored, pattern: SlytherFolderSource.expression(pattern.replace(/^\//, "")) });
        }

        return [...inherited, ...added];
    }

    /** Whether the rules in effect ignore the path, the last one that matches deciding, as git does. */
    private static ignored(path: string, directory: boolean, rules: Rule[]): boolean {
        let ignored = false;

        for (const rule of rules) {
            if (rule.dirOnly && !directory) {
                continue;
            }

            const against = rule.anchored ? relative(rule.dir, path).split(sep).join("/") : basename(path);

            if (against.startsWith("..") || !rule.pattern.test(against)) {
                continue;
            }

            ignored = !rule.negate;
        }

        return ignored;
    }

    /** A glob as an expression, with `**` crossing folders and `*` and `?` staying inside one. */
    private static expression(glob: string): RegExp {
        const source = glob
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*\//g, "\0")
            .replace(/\*\*/g, "")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]")
            .replace(/\0/g, "(?:.*/)?")
            .replace(//g, ".*");

        return new RegExp(`^${source}(?:/.*)?$`);
    }
}
