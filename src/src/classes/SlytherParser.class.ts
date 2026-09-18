// Imports
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";
import { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherClosureHasher } from "./SlytherClosureHasher.class.ts";
import { SlytherFolderSource } from "./SlytherFolderSource.class.ts";
import type { SlytherScript } from "./SlytherScript.class.ts";
import { StringUtils } from "./StringUtils.class.ts";

export class SlytherParser {
    /**
     * What may close the shape of a declaration: a brace and the tail that follows it, or `from "path"` or
     * `ref "path"` and, to report it, a brace written after the path as well.
     */
    private static readonly BODY = String.raw`\s*(?:(\{)(.*)|(from|ref)\s+["']([^"']+)["']\s*(\{.*)?)?\s*$`;
    /** `@artifact Name (args): qualifiers { tail`: declares a kind. The body is optional, the tail is whatever follows the brace. */
    private static readonly ARTIFACT = new RegExp(
        String.raw`^\s*@artifact\s+([A-Za-z_][\w-]*)\s*(?:\(([^)]*)\))?\s*(?::\s*([A-Za-z_][\w-]*(?:\s*,\s*[A-Za-z_][\w-]*)*))?` + SlytherParser.BODY,
    );
    /** `@run name (params) (config) { tail`: declares a script that runs the project. Only the body is required. */
    private static readonly RUN = new RegExp(
        String.raw`^\s*@run(?:\s+([A-Za-z_][\w-]*))?\s*(?:\(([^)]*)\))?\s*(?:\(([^)]*)\))?` + SlytherParser.BODY,
    );
    /** The namespace every script declared with `@run` lives in, which is also its kind. */
    static readonly RUN_KIND = "run";
    /** The name of a script declared with `@run` and no name. */
    static readonly RUN_DEFAULT = "default";
    private static readonly IMPORT = /^\s*@import\s+["']([^"']+)["']\s*$/;
    private static readonly LANG = /^\s*@lang\s+["']([^"']+)["']\s*$/;
    private static readonly USE = /^\s*@use\s+([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*$/;
    /**
     * `kind name (args): qualifiers { tail`: the args, the qualifiers and the body are optional, the
     * tail is whatever follows the brace on the same line.
     */
    private static readonly DECLARATION = new RegExp(
        String.raw`^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*(?:\(([^)]*)\))?\s*(?::\s*([A-Za-z_][\w-]*(?:\s*,\s*[A-Za-z_][\w-]*)*))?` + SlytherParser.BODY,
    );
    /** `kind (args) {`: a block opened with a kind but no name. */
    private static readonly UNNAMED = /^\s*([A-Za-z_][\w-]*)\s*(?:\([^)]*\))?\s*\{/;
    /** A line that would open a block but is meant as prose. */
    private static readonly ESCAPE = /^(\s*)\\(?=[A-Za-z_])/;
    private static readonly FENCE = /^\s*```/;
    private static readonly CODE = /```[\s\S]*?```|`[^`\n]*`/g;
    private static readonly REFERENCE =
        /(?<!\\)#\{\s*([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*\}/g;
    private static readonly SYMBOL = /^[A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*$/;
    private static readonly NUMBER = /^-?\d+(?:\.\d+)?$/;
    /** The kinds every script starts with. A kind itself is only declared through `@artifact`. */
    static readonly BUILTIN = ["namespace", "operation", "llm", "deterministic"];
    /** The types an arg may have without declaring anything. */
    static readonly TYPES = ["string", "number", "boolean"];
    /** Which kinds may open a block inside the body of which kind. A kind absent here nests nothing. */
    private static readonly CONTAINS: Record<string, readonly string[]> = {
        artifact: ["operation"],
        operation: ["llm", "deterministic"],
        run: ["deterministic"],
    };

    private declarations = new Map<
        string,
        { artifact: string; args: string; qualifiers: string; content: string; scope: string; source?: SlytherArtifact["source"] }
    >();
    private kinds = new Set<string>();
    private implicit = new Set<string>();
    private imported = new Set<string>();
    private lang: string | undefined;
    /** The script being read, which the path of a `from` or a `ref` is relative to. */
    private script = "";
    /** The folder the path of a `from` or a `ref` is kept relative to. */
    private base = "";
    /** Whether the declarations read are emitted by an expand, which may not take their prose from a file. */
    private emitted = false;

    /**
     * Parses the script. The path of every `from` and `ref` is kept relative to the given base, the folder
     * the prose is read from, which is the folder of the script when none is given.
     */
    parse(script: SlytherScript, base?: string): ParsedSlytherScript {
        this.declarations = new Map();
        this.kinds = new Set(SlytherParser.BUILTIN);
        this.implicit = new Set();
        this.imported = script.path ? new Set([resolve(script.path)]) : new Set();
        this.lang = undefined;
        this.base = resolve(base ?? (script.path ? dirname(script.path) : process.cwd()));
        this.emitted = false;

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
                declaration.source,
            );
        });

        return SlytherParser.hashed(artifacts, this.lang);
    }

    /**
     * Reads declarations into a script already parsed, as if they were written inside the given
     * artifact: each is named `Parent::name`, its scope is the parent, and it references the parent
     * whether or not its prose writes it. The source may hold nothing but declarations: a directive,
     * prose outside a block or a kind the parent may not contain throws. Returns the script with the
     * added artifacts and its hashes computed again, and the artifacts added.
     */
    extend(parsed: ParsedSlytherScript, parent: SlytherArtifact, source: string): { parsed: ParsedSlytherScript; added: SlytherArtifact[] } {
        this.declarations = new Map(
            parsed.artifacts.map((artifact) => [
                artifact.name,
                { artifact: artifact.artifact, args: "", qualifiers: "", content: "", scope: SlytherParser.scopeOf(artifact.name) },
            ]),
        );
        this.kinds = new Set([...SlytherParser.BUILTIN, ...parsed.artifacts.filter((artifact) => artifact.artifact === "artifact").map((artifact) => artifact.name)]);
        this.implicit = new Set();
        this.imported = new Set();
        this.lang = parsed.lang;
        this.emitted = true;

        const known = new Set(this.declarations.keys());
        const lines = source.split("\n");

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index]!;

            if (!line.trim()) {
                continue;
            }

            const declaration = SlytherParser.DECLARATION.exec(line);

            if (!declaration || line.trimStart().startsWith("@")) {
                throw new Error(`"${line.trim()}" is not a declaration.`);
            }

            const [, artifact, name, args, qualifiers, open, tail, mode, file, both] = declaration;

            if (artifact === "artifact") {
                throw new Error(`A kind is declared as "@artifact ${name}", not "artifact ${name}".`);
            }

            if (!this.kinds.has(artifact!)) {
                throw new Error(`Unknown artifact "${artifact}" of "${parent.name}::${name}".`);
            }

            index = this.declareAt(lines, index, artifact!, name!, `${parent.name}::${name}`, parent.name, args ?? "", qualifiers ?? "", SlytherParser.bodyOf(open, tail, mode, file, both, `${parent.name}::${name}`));
        }

        this.checkParents();

        const added = [...this.declarations]
            .filter(([name]) => !known.has(name))
            .map(([name, declaration]) => {
                const args = this.argumentsOf(declaration, name);
                const references = new Set([...this.referencesOf(declaration, args), `${parent.artifact}:${parent.name}`]);

                return new SlytherArtifact(declaration.artifact, name, args, this.qualifiersOf(declaration, name), declaration.content, [...references].sort(), declaration.source);
            });

        return { parsed: SlytherParser.hashed([...parsed.artifacts, ...added], parsed.lang), added };
    }

    private static hashed(artifacts: SlytherArtifact[], lang: string | undefined): ParsedSlytherScript {
        const hasher = new SlytherClosureHasher();

        return new ParsedSlytherScript(artifacts, hasher.hash(artifacts), hasher.scope(artifacts), lang);
    }

    /** The scope a qualified name was declared in: what comes before its last `::`. */
    private static scopeOf(name: string): string {
        const boundary = name.lastIndexOf("::");

        return boundary < 0 ? "" : name.slice(0, boundary);
    }

    private scan(source: string, path: string): void {
        const lines = source.split("\n");
        let scope = "";

        this.script = path;

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index] ?? "";
            const imported = SlytherParser.IMPORT.exec(line);

            if (imported) {
                this.import(imported[1]!, path);
                this.script = path;
                continue;
            }

            const lang = SlytherParser.LANG.exec(line);

            if (lang) {
                if (this.lang !== undefined) {
                    throw new Error(`The lang is declared twice: as "${this.lang}" and as "${lang[1]}".`);
                }

                this.lang = lang[1]!;
                continue;
            }

            const kind = SlytherParser.ARTIFACT.exec(line);

            if (kind) {
                const [, name, args, qualifiers, open, tail, mode, file, both] = kind;

                if (name === SlytherParser.RUN_KIND) {
                    throw new Error(`"${name}" is the kind of the scripts declared with @run and cannot be declared as a kind.`);
                }

                index = this.declareAt(lines, index, "artifact", name!, name!, "", args ?? "", qualifiers ?? "", SlytherParser.bodyOf(open, tail, mode, file, both, name!));
                continue;
            }

            const run = SlytherParser.RUN.exec(line);

            if (run) {
                const [, name = SlytherParser.RUN_DEFAULT, params, config, open, tail, mode, file, both] = run;

                if (!open && !mode) {
                    throw new Error(`The script "${name}" declared with @run must have a body in braces, or take it from a file with from or ref.`);
                }

                this.implicitNamespace(SlytherParser.RUN_KIND);
                index = this.declareAt(
                    lines,
                    index,
                    SlytherParser.RUN_KIND,
                    name,
                    `${SlytherParser.RUN_KIND}::${name}`,
                    SlytherParser.RUN_KIND,
                    SlytherParser.runArgsOf(name, params, config),
                    "",
                    SlytherParser.bodyOf(open, tail, mode, file, both, `${SlytherParser.RUN_KIND}::${name}`),
                );
                continue;
            }

            const use = SlytherParser.USE.exec(line);

            if (use) {
                scope = use[1]!;
                this.implicitNamespace(scope);
                continue;
            }

            const declaration = SlytherParser.DECLARATION.exec(line);

            if (!declaration) {
                continue;
            }

            const [, artifact, name, args, qualifiers, open, tail, mode, file, both] = declaration;
            const qualified = scope ? `${scope}::${name}` : name!;

            if (artifact === "artifact") {
                throw new Error(`A kind is declared as "@artifact ${name}", not "artifact ${name}".`);
            }

            if (!this.kinds.has(artifact!)) {
                throw new Error(`Unknown artifact "${artifact}" of "${qualified}".`);
            }

            index = this.declareAt(lines, index, artifact!, name!, qualified, scope, args ?? "", qualifiers ?? "", SlytherParser.bodyOf(open, tail, mode, file, both, qualified));
        }
    }

    /**
     * What closes a declaration: the tail after its brace, the file its prose is taken from, or nothing.
     * Throws when it has both a file and a brace.
     */
    private static bodyOf(
        open: string | undefined,
        tail: string | undefined,
        mode: string | undefined,
        file: string | undefined,
        both: string | undefined,
        owner: string,
    ): { tail: string } | { mode: "from" | "ref"; file: string } | undefined {
        if (both) {
            throw new Error(`"${owner}" takes its prose from "${file}", so it cannot have a body in braces as well.`);
        }

        return open ? { tail: tail! } : mode ? { mode: mode as "from" | "ref", file: file! } : undefined;
    }

    /** Declares the namespace unless something of that name is declared already, which a later declaration may replace. */
    private implicitNamespace(name: string): void {
        if (!this.declarations.has(name)) {
            this.declarations.set(name, { artifact: "namespace", args: "", qualifiers: "", content: "", scope: "" });
            this.implicit.add(name);
        }
    }

    /**
     * The args of a script as one list, params first. With two parens the first holds only types and the
     * second only values; a single paren holds either, but never both.
     */
    private static runArgsOf(name: string, params: string | undefined, config: string | undefined): string {
        const entriesOf = (text: string | undefined) =>
            text === undefined ? [] : StringUtils.splitUnquoted(text, ",").filter((entry) => entry.trim().length > 0);
        const isType = (entry: string) => {
            const value = entry.slice(entry.indexOf(":") + 1).trim();

            return !/^["']/.test(value) && !SlytherParser.NUMBER.test(value) && value !== "true" && value !== "false";
        };
        const first = entriesOf(params);
        const second = entriesOf(config);

        if (config !== undefined && (first.some((entry) => !isType(entry)) || second.some(isType))) {
            throw new Error(`The script "${name}" declared with @run takes its params in the first parens and its configuration in the second.`);
        }

        if (config === undefined && first.some(isType) && first.some((entry) => !isType(entry))) {
            throw new Error(`The script "${name}" declared with @run takes its params and its configuration in separate parens.`);
        }

        return [...first, ...second].join(",");
    }

    /**
     * Declares the artifact opened at the given line and reads its body, if it has one, up to the
     * brace that closes it, or the file its prose is taken from. Returns the index of the last line the
     * body took.
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
        body: ReturnType<typeof SlytherParser.bodyOf>,
    ): number {
        if (body && "mode" in body && this.emitted) {
            throw new Error(`"${qualified}" takes its prose ${body.mode} "${body.file}", but what an expand emits cannot take its prose from a file.`);
        }

        this.declare(qualified, artifact, scope, args, qualifiers);

        if (artifact === "artifact") {
            this.kinds.add(name);
        }

        if (body === undefined) {
            return index;
        }

        if ("mode" in body) {
            this.readSource(qualified, body.mode, body.file);

            return index;
        }

        const read = this.body(lines, index, body.tail, artifact, qualified);

        this.declarations.get(qualified)!.content = read.content;

        return read.end;
    }

    /**
     * Takes the prose of a declaration from a file, relative to the script being read: `from` embeds what
     * it holds, without the blank lines around it, and `ref` only points at it. Either way the source
     * keeps its hash, so a change to the file is a change to the artifact.
     *
     * A `ref` may point at a folder as well, since pointing at one is no different from pointing at a
     * file: the hash covers everything the folder holds. A `from` may not, since a folder holds no text
     * to embed.
     */
    private readSource(qualified: string, mode: "from" | "ref", file: string): void {
        const resolved = resolve(this.script ? dirname(this.script) : process.cwd(), file);
        const where = this.script || process.cwd();

        if (statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
            if (mode === "from") {
                throw new Error(`"${file}", the prose of "${qualified}", is a folder, which holds no text to embed with from. Point at it with ref instead.`);
            }

            const declaration = this.declarations.get(qualified)!;

            declaration.content = "";
            declaration.source = { mode, path: relative(this.base, resolved) + sep, hash: SlytherFolderSource.hash(resolved) };

            return;
        }

        let text: string;

        try {
            text = readFileSync(resolved, "utf-8");
        } catch {
            throw new Error(`Cannot read "${file}", the prose of "${qualified}", from "${where}".`);
        }

        const declaration = this.declarations.get(qualified)!;

        declaration.content = mode === "from" ? text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd() : "";
        declaration.source = { mode, path: relative(this.base, resolved), hash: createHash("sha256").update(text).digest("hex") };
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
                if (SlytherParser.ESCAPE.test(line) && (SlytherParser.DECLARATION.test(line.replace("\\", "")) || SlytherParser.UNNAMED.test(line.replace("\\", "")))) {
                    line = line.replace("\\", "");
                } else {
                    const nested = SlytherParser.DECLARATION.exec(line);

                    if (nested?.[5] || nested?.[7]) {
                        const [, child, name, args, qualifiers, open, rest, mode, file, both] = nested;

                        if (allowed.includes(child!)) {
                            index = this.declareAt(lines, index, child!, name!, `${owner}::${name}`, owner, args ?? "", qualifiers ?? "", SlytherParser.bodyOf(open, rest, mode, file, both, `${owner}::${name}`));

                            if (++index >= lines.length) {
                                throw new Error(`Unterminated ${artifact} "${owner}".`);
                            }

                            line = lines[index]!;
                            continue;
                        }

                        if (this.kinds.has(child!)) {
                            throw new Error(`"${child}" cannot be declared inside ${artifact} "${owner}".`);
                        }
                    } else {
                        const unnamed = SlytherParser.UNNAMED.exec(line)?.[1];

                        if (unnamed && allowed.includes(unnamed)) {
                            throw new Error(`The ${unnamed} block inside ${artifact} "${owner}" needs a name, as in "${unnamed} setup {".`);
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
    ): Omit<SlytherArtifact["args"][number], "name"> {
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

        const optional = value.endsWith("?");
        const type = optional ? value.slice(0, -1).trim() : value;

        if (!SlytherParser.SYMBOL.test(type)) {
            throw new Error(`Malformed value "${value}" of argument "${argument}" of "${owner}".`);
        }

        if (!SlytherParser.TYPES.includes(type) && !this.resolve(type, scope)) {
            throw new Error(`Unknown type "${type}" of argument "${argument}" of "${owner}".`);
        }

        return optional ? { kind: "type", value: type, optional } : { kind: "type", value: type };
    }

    private referencesOf(declaration: { content: string; scope: string; source?: SlytherArtifact["source"] }, args: SlytherArtifact["args"]): string[] {
        const prose = declaration.source ? "" : declaration.content.replace(SlytherParser.CODE, "");
        const written = [
            ...[...prose.matchAll(SlytherParser.REFERENCE)].map((match) => match[1]!),
            ...args
                .filter((arg) => arg.kind === "type" && !SlytherParser.TYPES.includes(String(arg.value)))
                .map((arg) => String(arg.value)),
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
