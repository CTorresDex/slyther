// Imports
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherClosureHasher } from "./SlytherClosureHasher.class.ts";
import type { SlytherScript } from "./SlytherScript.class.ts";
import { StringUtils } from "./StringUtils.class.ts";

export class SlytherParser {
    /** `@artifact Name (args): qualifiers { tail`: declares a kind. The brace is optional, the tail is whatever follows it. */
    private static readonly ARTIFACT =
        /^\s*@artifact\s+([A-Za-z_][\w-]*)\s*(?:\(([^)]*)\))?\s*(?::\s*([A-Za-z_][\w-]*(?:\s*,\s*[A-Za-z_][\w-]*)*))?\s*(?:(\{)(.*))?$/;
    private static readonly IMPORT = /^\s*@import\s+["']([^"']+)["']\s*$/;
    private static readonly USE = /^\s*@use\s+([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*$/;
    /**
     * `kind name (args): qualifiers { tail`: the args, the qualifiers and the brace are optional, the
     * tail is whatever follows the brace on the same line.
     */
    private static readonly DECLARATION =
        /^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*(?:\(([^)]*)\))?\s*(?::\s*([A-Za-z_][\w-]*(?:\s*,\s*[A-Za-z_][\w-]*)*))?\s*(?:(\{)(.*))?$/;
    /** A line that would open a block but is meant as prose. */
    private static readonly ESCAPE = /^(\s*)\\(?=[A-Za-z_])/;
    private static readonly FENCE = /^\s*```/;
    private static readonly CODE = /```[\s\S]*?```|`[^`\n]*`/g;
    private static readonly REFERENCE =
        /(?<!\\)#\{\s*([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*\}/g;
    private static readonly SYMBOL = /^[A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*$/;
    private static readonly NUMBER = /^-?\d+(?:\.\d+)?$/;
    /** The kinds every script starts with. A kind itself is only declared through `@artifact`. */
    private static readonly BUILTIN = ["namespace", "operation", "llm", "deterministic"];
    /** Which kinds may open a block inside the body of which kind. A kind absent here nests nothing. */
    private static readonly CONTAINS: Record<string, readonly string[]> = {
        artifact: ["operation"],
        operation: ["llm", "deterministic"],
    };

    private declarations = new Map<
        string,
        { artifact: string; args: string; qualifiers: string; content: string; scope: string }
    >();
    private kinds = new Set<string>();
    private implicit = new Set<string>();
    private imported = new Set<string>();

    parse(script: SlytherScript): ParsedSlytherScript {
        this.declarations = new Map();
        this.kinds = new Set(SlytherParser.BUILTIN);
        this.implicit = new Set();
        this.imported = script.path ? new Set([resolve(script.path)]) : new Set();

        this.scan(script.source, script.path);

        this.checkParents();

        const artifacts = [...this.declarations].map(([name, declaration]) => {
            const args = this.argumentsOf(declaration, name);

            return new SlytherArtifact(
                declaration.artifact,
                name,
                args,
                this.qualifiersOf(declaration, name),
                declaration.content,
                this.referencesOf(declaration, args),
            );
        });

        return new ParsedSlytherScript(artifacts, new SlytherClosureHasher().hash(artifacts));
    }

    private scan(source: string, path: string): void {
        const lines = source.split("\n");
        let scope = "";

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index] ?? "";
            const imported = SlytherParser.IMPORT.exec(line);

            if (imported) {
                this.import(imported[1]!, path);
                continue;
            }

            const kind = SlytherParser.ARTIFACT.exec(line);

            if (kind) {
                const [, name, args, qualifiers, open, tail] = kind;

                index = this.declareAt(lines, index, "artifact", name!, name!, "", args ?? "", qualifiers ?? "", open ? tail! : undefined);
                continue;
            }

            const use = SlytherParser.USE.exec(line);

            if (use) {
                scope = use[1]!;

                if (!this.declarations.has(scope)) {
                    this.declarations.set(scope, {
                        artifact: "namespace",
                        args: "",
                        qualifiers: "",
                        content: "",
                        scope: "",
                    });
                    this.implicit.add(scope);
                }

                continue;
            }

            const declaration = SlytherParser.DECLARATION.exec(line);

            if (!declaration) {
                continue;
            }

            const [, artifact, name, args, qualifiers, open, tail] = declaration;
            const qualified = scope ? `${scope}::${name}` : name!;

            if (artifact === "artifact") {
                throw new Error(`A kind is declared as "@artifact ${name}", not "artifact ${name}".`);
            }

            if (!this.kinds.has(artifact!)) {
                throw new Error(`Unknown artifact "${artifact}" of "${qualified}".`);
            }

            index = this.declareAt(lines, index, artifact!, name!, qualified, scope, args ?? "", qualifiers ?? "", open ? tail! : undefined);
        }
    }

    /**
     * Declares the artifact opened at the given line and reads its body, if it has one, up to the
     * brace that closes it. Returns the index of the last line the body took.
     */
    private declareAt(
        lines: string[],
        index: number,
        artifact: string,
        name: string,
        qualified: string,
        scope: string,
        args: string,
        qualifiers: string,
        tail: string | undefined,
    ): number {
        this.declare(qualified, artifact, scope, args, qualifiers);

        if (artifact === "artifact") {
            this.kinds.add(name);
        }

        if (tail === undefined) {
            return index;
        }

        const body = this.body(lines, index, tail, artifact, qualified);

        this.declarations.get(qualified)!.content = body.content;

        return body.end;
    }

    /**
     * Reads the body of a block from the tail of its opening line to its closing brace. Fenced and
     * inline code is opaque: it neither opens nor closes anything. A line that opens a block of a kind
     * the owner may contain is declared as its child and left out of the content; a backslash in front
     * of such a line keeps it as prose.
     */
    private body(
        lines: string[],
        index: number,
        tail: string,
        artifact: string,
        owner: string,
    ): { content: string; end: number } {
        const allowed = SlytherParser.CONTAINS[artifact] ?? [];
        const body: string[] = [];
        let line = tail;
        let depth = 1;
        let fenced = false;

        for (;;) {
            if (SlytherParser.FENCE.test(line)) {
                fenced = !fenced;
            }

            if (!fenced && !SlytherParser.FENCE.test(line)) {
                if (SlytherParser.ESCAPE.test(line) && SlytherParser.DECLARATION.test(line.replace("\\", ""))) {
                    line = line.replace("\\", "");
                } else {
                    const nested = SlytherParser.DECLARATION.exec(line);

                    if (nested?.[5]) {
                        const [, child, name, args, qualifiers, , rest] = nested;

                        if (allowed.includes(child!)) {
                            index = this.declareAt(lines, index, child!, name!, `${owner}::${name}`, owner, args ?? "", qualifiers ?? "", rest!);

                            if (++index >= lines.length) {
                                throw new Error(`Unterminated ${artifact} "${owner}".`);
                            }

                            line = lines[index]!;
                            continue;
                        }

                        if (this.kinds.has(child!)) {
                            throw new Error(`"${child}" cannot be declared inside ${artifact} "${owner}".`);
                        }
                    }

                    const closed = this.closeOf(line, depth);

                    if (closed.depth === 0) {
                        if (line.slice(closed.at + 1).trim()) {
                            throw new Error(`Unexpected text after the end of ${artifact} "${owner}".`);
                        }

                        body.push(line.slice(0, closed.at));

                        return { content: StringUtils.dedent(body), end: index };
                    }

                    depth = closed.depth;
                }
            }

            body.push(line);

            if (++index >= lines.length) {
                throw new Error(`Unterminated ${artifact} "${owner}".`);
            }

            line = lines[index]!;
        }
    }

    /** Counts the braces of a line outside inline code, and where the brace that closes the block is, if any. */
    private closeOf(line: string, depth: number): { depth: number; at: number } {
        let code = false;

        for (let at = 0; at < line.length; at++) {
            const character = line[at];

            if (character === "`") {
                code = !code;
            } else if (code) {
                continue;
            } else if (character === "{") {
                depth++;
            } else if (character === "}" && --depth === 0) {
                return { depth, at };
            }
        }

        return { depth, at: -1 };
    }

    private declare(name: string, artifact: string, scope: string, args = "", qualifiers = "", content = ""): void {
        if (this.declarations.has(name) && !this.implicit.delete(name)) {
            throw new Error(`Duplicate declaration "${name}".`);
        }

        this.declarations.set(name, { artifact, args, qualifiers, content, scope });
    }

    private import(target: string, path: string): void {
        const resolved = resolve(path ? dirname(path) : process.cwd(), target);

        if (this.imported.has(resolved)) {
            return;
        }

        this.imported.add(resolved);

        let source: string;

        try {
            source = readFileSync(resolved, "utf-8");
        } catch {
            throw new Error(`Cannot import "${target}" from "${path || process.cwd()}".`);
        }

        this.scan(source, resolved);
    }

    private checkParents(): void {
        for (const name of this.declarations.keys()) {
            const boundary = name.lastIndexOf("::");

            if (boundary >= 0 && !this.declarations.has(name.slice(0, boundary))) {
                throw new Error(`Unknown parent "${name.slice(0, boundary)}" of "${name}".`);
            }
        }
    }

    private argumentsOf(declaration: { args: string; scope: string }, owner: string): SlytherArtifact["args"] {
        return StringUtils.splitUnquoted(declaration.args, ",").map((entry) => {
            const boundary = entry.indexOf(":");
            const name = boundary < 0 ? "" : entry.slice(0, boundary).trim();

            if (!SlytherParser.SYMBOL.test(name)) {
                throw new Error(`Malformed argument "${entry.trim()}" of "${owner}".`);
            }

            const value = entry.slice(boundary + 1).trim();

            return { name, ...this.valueOf(value, name, owner, declaration.scope) };
        });
    }

    /** The bare words after the colon, in the order written; writing one twice throws. */
    private qualifiersOf(declaration: { qualifiers: string }, owner: string): string[] {
        const qualifiers = declaration.qualifiers
            .split(",")
            .map((qualifier) => qualifier.trim())
            .filter((qualifier) => qualifier.length > 0);
        const repeated = qualifiers.find((qualifier, index) => qualifiers.indexOf(qualifier) !== index);

        if (repeated) {
            throw new Error(`Qualifier "${repeated}" is written twice on "${owner}".`);
        }

        return qualifiers;
    }

    private valueOf(
        value: string,
        argument: string,
        owner: string,
        scope: string,
    ): { kind: "string" | "number" | "boolean" | "type"; value: string | number | boolean } {
        const quote = value.charAt(0);

        if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
            return { kind: "string", value: value.slice(1, -1) };
        }

        if (value === "true" || value === "false") {
            return { kind: "boolean", value: value === "true" };
        }

        if (SlytherParser.NUMBER.test(value)) {
            return { kind: "number", value: Number(value) };
        }

        if (!SlytherParser.SYMBOL.test(value)) {
            throw new Error(`Malformed value "${value}" of argument "${argument}" of "${owner}".`);
        }

        if (!this.resolve(value, scope)) {
            throw new Error(`Unknown type "${value}" of argument "${argument}" of "${owner}".`);
        }

        return { kind: "type", value };
    }

    private referencesOf(declaration: { content: string; scope: string }, args: SlytherArtifact["args"]): string[] {
        const prose = declaration.content.replace(SlytherParser.CODE, "");
        const written = [
            ...[...prose.matchAll(SlytherParser.REFERENCE)].map((match) => match[1]!),
            ...args.filter((arg) => arg.kind === "type").map((arg) => String(arg.value)),
        ];

        const references = written.map((name) => {
            const resolved = this.resolve(name, declaration.scope);

            if (!resolved) {
                throw new Error(`Unknown reference "${name}".`);
            }

            return `${this.declarations.get(resolved)!.artifact}:${resolved}`;
        });

        return [...new Set(references)].sort();
    }

    /** Looks the name up in the scope, then in each enclosing scope, then globally. */
    private resolve(name: string, scope: string): string | undefined {
        for (let prefix = scope; ; ) {
            const candidate = prefix ? `${prefix}::${name}` : name;

            if (this.declarations.has(candidate)) {
                return candidate;
            }

            if (!prefix) {
                return undefined;
            }

            const boundary = prefix.lastIndexOf("::");

            prefix = boundary < 0 ? "" : prefix.slice(0, boundary);
        }
    }
}
