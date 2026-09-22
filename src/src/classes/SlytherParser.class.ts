// Imports
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherClosureHasher } from "./SlytherClosureHasher.class.ts";
import { SlytherFolderSource } from "./SlytherFolderSource.class.ts";
import { SlytherRole } from "./SlytherRole.class.ts";
import type { SlytherScript } from "./SlytherScript.class.ts";
import { SlytherSourceMap } from "./SlytherSourceMap.class.ts";
import { StringUtils } from "./StringUtils.class.ts";

export class SlytherParser {
    /**
     * What may close the shape of a declaration: a brace and the tail that follows it, or `from "path"` or
     * `ref "path"` and, to report it, a brace written after the path as well.
     */
    private static readonly BODY = String.raw`\s*(?:(\{)(.*)|(from|ref)\s+["']([^"']+)["']\s*(\{.*)?)?\s*$`;
    /** `@artifact Name (params) (config): qualifiers { tail`: declares a kind. Only the name is required, the tail is whatever follows the brace. */
    private static readonly ARTIFACT = new RegExp(
        String.raw`^\s*@artifact\s+([A-Za-z_][\w-]*)\s*(?:\(([^)]*)\))?\s*(?:\(([^)]*)\))?\s*(?::\s*([A-Za-z_][\w-]*(?:\s*,\s*[A-Za-z_][\w-]*)*))?` + SlytherParser.BODY,
        "d",
    );
    /** `@run name (params) (config) { tail`: declares a script that runs the project. Only the body is required. */
    private static readonly RUN = new RegExp(
        String.raw`^\s*@run(?:\s+([A-Za-z_][\w-]*))?\s*(?:\(([^)]*)\))?\s*(?:\(([^)]*)\))?` + SlytherParser.BODY,
        "d",
    );
    /** The namespace every script declared with `@run` lives in, which is also its kind. */
    static readonly RUN_KIND = "run";
    /** The name of a script declared with `@run` and no name. */
    static readonly RUN_DEFAULT = "default";
    private static readonly IMPORT = /^\s*@import\s+["']([^"']+)["']\s*$/d;
    /**
     * What an `@import` writes to name a package instead of a path: a bare name. Anything with a
     * separator, a dot or a drive is a path, so a package is never confused with one.
     */
    private static readonly PACKAGE = /^[A-Za-z_][\w-]*$/;
    /** Where a project installs its packages, relative to its root, and the entry point of one. */
    static readonly PACKAGES = join(".slyther", "packages");
    static readonly PACKAGE_ENTRY = "main.sly";
    private static readonly LANG = /^\s*@lang\s+["']([^"']+)["']\s*$/;
    /** `@role name "provider" (options)`: who plays a role, the options optional. */
    private static readonly ROLE = /^\s*@role\s+(\S+)\s+["']([^"']+)["']\s*(?:\((.*)\))?\s*$/;
    /** `key: "value"`: an option of a `@role`, always a quoted string, since it is handed to the provider as it is. */
    private static readonly OPTION = /^\s*([A-Za-z_][\w-]*)\s*:\s*(?:"([^"]*)"|'([^']*)')\s*$/;
    private static readonly USE = /^\s*@use\s+([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*$/;
    /**
     * `kind name (args): qualifiers { tail`: the args, the qualifiers and the body are optional, the
     * tail is whatever follows the brace on the same line.
     */
    private static readonly DECLARATION = new RegExp(
        String.raw`^\s*([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s+([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*(?:\(([^)]*)\))?\s*(?::\s*([A-Za-z_][\w-]*(?:\s*,\s*[A-Za-z_][\w-]*)*))?` + SlytherParser.BODY,
        "d",
    );
    /** `kind (args) {`: a block opened with a kind but no name. */
    private static readonly UNNAMED = /^\s*([A-Za-z_][\w-]*)\s*(?:\([^)]*\))?\s*\{/;
    /** A line that would open a block but is meant as prose. */
    private static readonly ESCAPE = /^(\s*)\\(?=[A-Za-z_])/;
    private static readonly FENCE = /^\s*```/;
    private static readonly CODE = /```[\s\S]*?```|`[^`\n]*`/g;
    /** Inline code on one line, which nothing inside references anything. */
    private static readonly INLINE = /`[^`\n]*`/g;
    private static readonly REFERENCE =
        /(?<!\\)#\{\s*([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*\}/g;
    private static readonly SYMBOL = /^[A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*$/;
    private static readonly NUMBER = /^-?\d+(?:\.\d+)?$/;
    /** The kinds every script starts with. A kind itself is only declared through `@artifact`. */
    static readonly BUILTIN = ["namespace", "operation", "llm", "deterministic"];
    /** The types an arg may have without declaring anything. */
    static readonly TYPES = ["string", "number", "boolean"];
    /** Which kinds may open a block inside the body of which kind. A kind absent here nests nothing. */
    static readonly CONTAINS: Record<string, readonly string[]> = {
        artifact: ["operation"],
        operation: ["llm", "deterministic"],
        run: ["deterministic"],
    };

    private declarations = new Map<
        string,
        {
            artifact: string;
            args: string;
            qualifiers: string;
            content: string;
            scope: string;
            source?: SlytherArtifact["source"];
            /** Where it was written, so a problem found after reading it is reported there. */
            where?: SlytherParser["where"];
        }
    >();
    private kinds = new Set<string>();
    private implicit = new Set<string>();
    private imported = new Set<string>();
    /** The package every declaration read came from, keyed by its qualified name. */
    private packaged = new Map<string, string>();
    /** The package being read, kept while what an `@import` of a package pulls in is scanned. */
    private owner: string | undefined;
    /** The folder the packages of the project are installed in. */
    private packages = "";
    private lang: string | undefined;
    /** Who plays every role the project binds with `@role`, keyed by the role. */
    private roles = new Map<string, SlytherRole["binding"]>();
    /** The script being read, which the path of a `from` or a `ref` is relative to. */
    private script = "";
    /** The folder the path of a `from` or a `ref` is kept relative to. */
    private base = "";
    /** Whether the declarations read are emitted by an expand, which may not take their prose from a file. */
    private emitted = false;
    /** Where everything read was written, and what was found wrong, for the script last parsed. */
    map = new SlytherSourceMap();
    /** The line being read, where a problem is reported unless it knows a better place. */
    private at = { file: "", line: 0, length: 0 };
    /** The shape of where a declaration was written: never a value, only the type of the field. */
    private declare where: {
        file: string;
        line: number;
        length: number;
        kind: { start: number; end: number };
        name: { start: number; end: number };
        /** The columns of every arg, aligned with what splitting the args gives. */
        entries: { start: number; end: number }[];
        /** The columns of the path of a `from` or a `ref`, if any. */
        path?: { start: number; end: number };
        /** Whether the declaration opens with a directive rather than a kind. */
        directive: boolean;
    };

    constructor(
        private readonly options: {
            /** Record what is wrong in the map and keep reading, instead of throwing at the first problem. */
            lenient?: boolean;
            /** What a path holds, instead of what the disk does; undefined leaves it to the disk. */
            read?: (path: string) => string | undefined;
            /** Where the packages are installed; undefined puts them under the folder of the entry point. */
            packages?: string;
        } = {},
    ) {}

    /**
     * Parses the script. The path of every `from` and `ref` is kept relative to the given base, the folder
     * the prose is read from, which is the folder of the script when none is given.
     */
    parse(script: SlytherScript, base?: string): ParsedSlytherScript {
        this.declarations = new Map();
        this.kinds = new Set(SlytherParser.BUILTIN);
        this.implicit = new Set();
        this.imported = script.path ? new Set([resolve(script.path)]) : new Set();
        this.packaged = new Map();
        this.owner = undefined;
        this.packages = resolve(this.options.packages ?? join(script.path ? dirname(script.path) : process.cwd(), SlytherParser.PACKAGES));
        this.lang = undefined;
        this.roles = new Map();
        this.base = resolve(base ?? (script.path ? dirname(script.path) : process.cwd()));
        this.emitted = false;
        this.map = new SlytherSourceMap();

        this.scan(script.source, script.path ? resolve(script.path) : "");

        this.checkParents();

        const artifacts = [...this.declarations].map(([name, declaration]) => {
            this.locate(declaration);

            const args = this.argumentsOf(declaration, name);

            return new SlytherArtifact(
                declaration.artifact,
                name,
                args,
                this.qualifiersOf(declaration, name),
                declaration.content,
                this.referencesOf(declaration, args, name),
                declaration.source,
            );
        });

        for (const reference of this.map.references) {
            reference.target = this.resolve(reference.name, reference.scope);
        }

        return SlytherParser.hashed(artifacts, this.lang, this.packaged, this.roles);
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
        this.packaged = new Map(parsed.packages);
        this.owner = undefined;
        this.lang = parsed.lang;
        this.emitted = true;
        this.map = new SlytherSourceMap();
        this.script = "";

        const known = new Set(this.declarations.keys());
        const lines = source.split("\n");

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index]!;

            this.at = { file: "", line: index, length: line.length };

            if (!line.trim()) {
                continue;
            }

            const declaration = SlytherParser.DECLARATION.exec(line);

            if (!declaration || line.trimStart().startsWith("@")) {
                this.fail(`"${line.trim()}" is not a declaration.`);
                continue;
            }

            const [, artifact, name, args, qualifiers, open, tail, mode, file, both] = declaration;

            const kind = this.resolveKind(artifact!, parent.name);

            if (artifact === "artifact") {
                this.fail(`A kind is declared as "@artifact ${name}", not "artifact ${name}".`);
            } else if (kind === undefined) {
                this.fail(this.unknownKind(artifact!, `${parent.name}::${name}`));
            }

            index = this.declareAt(
                lines,
                index,
                kind ?? artifact!,
                name!,
                `${parent.name}::${name}`,
                parent.name,
                args ?? "",
                qualifiers ?? "",
                this.bodyOf(open, tail, mode, file, both, `${parent.name}::${name}`),
                SlytherParser.whereOf("", index, line, declaration, { kind: 1, name: 2, args: [3], path: 8 }),
            );
        }

        this.checkParents();

        const added = [...this.declarations]
            .filter(([name]) => !known.has(name))
            .map(([name, declaration]) => {
                this.locate(declaration);

                const args = this.argumentsOf(declaration, name);
                const references = new Set([...this.referencesOf(declaration, args, name), `${parent.artifact}:${parent.name}`]);

                return new SlytherArtifact(declaration.artifact, name, args, this.qualifiersOf(declaration, name), declaration.content, [...references].sort(), declaration.source);
            });

        return { parsed: SlytherParser.hashed([...parsed.artifacts, ...added], parsed.lang, parsed.packages, parsed.roles), added };
    }

    /** The parsed script, its hashes computed from the artifacts alone: who plays a role changes no hash. */
    private static hashed(
        artifacts: SlytherArtifact[],
        lang: string | undefined,
        packages: Map<string, string>,
        roles: Map<string, SlytherRole["binding"]>,
    ): ParsedSlytherScript {
        const hasher = new SlytherClosureHasher();

        return new ParsedSlytherScript(artifacts, hasher.hash(artifacts), hasher.scope(artifacts), lang, packages, roles);
    }

    /** The scope a qualified name was declared in: what comes before its last `::`. */
    private static scopeOf(name: string): string {
        const boundary = name.lastIndexOf("::");

        return boundary < 0 ? "" : name.slice(0, boundary);
    }

    /**
     * Reports a problem: throws it, or, when lenient, records it where given, or on the line being read,
     * and returns so reading goes on.
     */
    private fail(message: string, where?: { file: string; line: number; start: number; end: number }): void {
        if (!this.options.lenient) {
            throw new Error(message);
        }

        const { file, line, start, end } = where ?? { file: this.at.file, line: this.at.line, start: 0, end: this.at.length };

        this.map.diagnostics.push({ file, line, start, end, message, severity: "error" });
    }

    /** Points the line being read at where the declaration was written, so a problem found late is reported there. */
    private locate(declaration: { where?: SlytherParser["where"] }): void {
        if (declaration.where) {
            this.at = { file: declaration.where.file, line: declaration.where.line, length: declaration.where.length };
        }
    }

    /** The whole line of a declaration, where a problem with it is reported when no column knows better. */
    private static lineOf(where: SlytherParser["where"] | undefined): { file: string; line: number; start: number; end: number } | undefined {
        return where && { file: where.file, line: where.line, start: 0, end: where.length };
    }

    /** What a path holds: what the reader given says, else what the disk does, else undefined. */
    private read(path: string): string | undefined {
        const text = this.options.read?.(path);

        if (text !== undefined) {
            return text;
        }

        try {
            return readFileSync(path, "utf-8");
        } catch {
            return undefined;
        }
    }

    /** The columns of a group of a match, or undefined when the group matched nothing. */
    private static spanOf(match: RegExpExecArray, group: number): { start: number; end: number } | undefined {
        const indices = match.indices?.[group];

        return indices && { start: indices[0], end: indices[1] };
    }

    /**
     * Where a declaration was written, from the match that read its opening line: the kind is a group
     * of the match, or a directive found on the line, and the args are one or two groups.
     */
    private static whereOf(
        file: string,
        line: number,
        text: string,
        match: RegExpExecArray,
        groups: { kind: number | string; name: number; args: number[]; path: number },
    ): SlytherParser["where"] {
        const directive = typeof groups.kind === "string";
        const start = typeof groups.kind === "string" ? text.indexOf(groups.kind) : match.indices![groups.kind]![0];
        const kind = { start, end: typeof groups.kind === "string" ? start + groups.kind.length : match.indices![groups.kind]![1] };

        return {
            file,
            line,
            length: text.length,
            kind,
            name: SlytherParser.spanOf(match, groups.name) ?? kind,
            entries: groups.args.flatMap((group) => SlytherParser.entriesAt(text, SlytherParser.spanOf(match, group))),
            path: SlytherParser.spanOf(match, groups.path),
            directive,
        };
    }

    /** The columns of every arg written between the given columns, without the whitespace around it, aligned with how the args are split. */
    private static entriesAt(line: string, span: { start: number; end: number } | undefined): { start: number; end: number }[] {
        if (!span) {
            return [];
        }

        const text = line.slice(span.start, span.end);
        const spans: { start: number; end: number }[] = [];
        let cursor = 0;

        for (const entry of StringUtils.splitUnquoted(text, ",")) {
            const at = text.indexOf(entry, cursor);
            const leading = entry.length - entry.trimStart().length;

            spans.push({ start: span.start + at + leading, end: span.start + at + entry.trimEnd().length });
            cursor = at + entry.length + 1;
        }

        return spans;
    }

    private scan(source: string, path: string): void {
        const lines = source.split("\n");
        let scope = "";

        this.script = path;
        this.map.files.push(path);

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index] ?? "";

            this.at = { file: path, line: index, length: line.length };

            const imported = SlytherParser.IMPORT.exec(line);

            if (imported) {
                const specifier = imported[1]!;
                const owner = SlytherParser.PACKAGE.test(specifier) ? specifier : undefined;
                const target = owner ? join(this.packages, owner, SlytherParser.PACKAGE_ENTRY) : resolve(path ? dirname(path) : process.cwd(), specifier);

                this.map.paths.push({ file: path, line: index, ...SlytherParser.spanOf(imported, 1)!, directive: "import", path: target });
                this.import(target, specifier, path, owner);
                this.script = path;
                continue;
            }

            const lang = SlytherParser.LANG.exec(line);

            if (lang) {
                if (this.lang !== undefined) {
                    this.fail(`The lang is declared twice: as "${this.lang}" and as "${lang[1]}".`);
                    continue;
                }

                this.lang = lang[1]!;
                continue;
            }

            const role = SlytherParser.ROLE.exec(line);

            if (role) {
                this.bind(role[1]!, role[2]!, role[3], path, index);
                continue;
            }

            if (/^\s*@role\b/.test(line)) {
                this.fail(`"${line.trim()}" is not a role: write it as @role name "provider" (option: "value", ...).`);
                continue;
            }

            const kind = SlytherParser.ARTIFACT.exec(line);

            if (kind) {
                const [, name, params, config, qualifiers, open, tail, mode, file, both] = kind;

                if (name === SlytherParser.RUN_KIND) {
                    this.fail(`"${name}" is the kind of the scripts declared with @run and cannot be declared as a kind.`);
                }

                index = this.declareAt(
                    lines,
                    index,
                    "artifact",
                    name!,
                    scope ? `${scope}::${name}` : name!,
                    scope,
                    this.groupedArgsOf(`The kind "${name}"`, "@artifact", params, config),
                    qualifiers ?? "",
                    this.bodyOf(open, tail, mode, file, both, name!),
                    SlytherParser.whereOf(path, index, line, kind, { kind: "@artifact", name: 1, args: [2, 3], path: 8 }),
                );
                continue;
            }

            const run = SlytherParser.RUN.exec(line);

            if (run) {
                const [, name = SlytherParser.RUN_DEFAULT, params, config, open, tail, mode, file, both] = run;

                if (!open && !mode) {
                    this.fail(`The script "${name}" declared with @run must have a body in braces, or take it from a file with from or ref.`);
                }

                this.implicitNamespace(SlytherParser.RUN_KIND);
                index = this.declareAt(
                    lines,
                    index,
                    SlytherParser.RUN_KIND,
                    name,
                    `${SlytherParser.RUN_KIND}::${name}`,
                    SlytherParser.RUN_KIND,
                    this.groupedArgsOf(`The script "${name}"`, "@run", params, config),
                    "",
                    this.bodyOf(open, tail, mode, file, both, `${SlytherParser.RUN_KIND}::${name}`),
                    SlytherParser.whereOf(path, index, line, run, { kind: "@run", name: 1, args: [2, 3], path: 7 }),
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

            const declared = this.resolveKind(artifact!, scope);

            if (artifact === "artifact") {
                this.fail(`A kind is declared as "@artifact ${name}", not "artifact ${name}".`);
            } else if (declared === undefined) {
                this.fail(this.unknownKind(artifact!, qualified));
            }

            index = this.declareAt(
                lines,
                index,
                declared ?? artifact!,
                name!,
                qualified,
                scope,
                args ?? "",
                qualifiers ?? "",
                this.bodyOf(open, tail, mode, file, both, qualified),
                SlytherParser.whereOf(path, index, line, declaration, { kind: 1, name: 2, args: [3], path: 8 }),
            );
        }
    }

    /**
     * What closes a declaration: the tail after its brace, the file its prose is taken from, or nothing.
     * Throws when it has both a file and a brace, or, when lenient, keeps the brace and drops the file.
     */
    private bodyOf(
        open: string | undefined,
        tail: string | undefined,
        mode: string | undefined,
        file: string | undefined,
        both: string | undefined,
        owner: string,
    ): { tail: string } | { mode: "from" | "ref"; file: string } | undefined {
        if (both) {
            this.fail(`"${owner}" takes its prose from "${file}", so it cannot have a body in braces as well.`);

            return { tail: both.slice(1) };
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
     * The args of a declaration written in two parens as one list, params first. With two parens the
     * first holds only types and the second only values; a single paren holds either, but never both.
     */
    private groupedArgsOf(what: string, directive: string, params: string | undefined, config: string | undefined): string {
        const entriesOf = (text: string | undefined) =>
            text === undefined ? [] : StringUtils.splitUnquoted(text, ",").filter((entry) => entry.trim().length > 0);
        const isType = (entry: string) => {
            const value = entry.slice(entry.indexOf(":") + 1).trim();

            return !/^["']/.test(value) && !SlytherParser.NUMBER.test(value) && value !== "true" && value !== "false";
        };
        const first = entriesOf(params);
        const second = entriesOf(config);

        if (config !== undefined && (first.some((entry) => !isType(entry)) || second.some(isType))) {
            this.fail(`${what} declared with ${directive} takes its params in the first parens and its configuration in the second.`);
        } else if (config === undefined && first.some(isType) && first.some((entry) => !isType(entry))) {
            this.fail(`${what} declared with ${directive} takes its params and its configuration in separate parens.`);
        }

        return [...first, ...second].join(",");
    }

    /**
     * Declares the artifact opened at the given line and reads its body, if it has one, up to the
     * brace that closes it, or the file its prose is taken from. Records where it was written, the kind
     * that opens it and the type of every arg as references. Returns the index of the last line the
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
        body: ReturnType<SlytherParser["bodyOf"]>,
        where: SlytherParser["where"],
    ): number {
        const line = lines[index]!;
        const written = { name: qualified, artifact, scope, file: where.file, line: index, last: index, kind: where.kind, at: where.name };

        this.map.declarations.push(written);

        if (body && "mode" in body && this.emitted) {
            this.fail(`"${qualified}" takes its prose ${body.mode} "${body.file}", but what an expand emits cannot take its prose from a file.`);
            body = undefined;
        }

        this.declare(qualified, artifact, scope, args, qualifiers, where);

        if (artifact === "artifact") {
            this.kinds.add(qualified);
        }

        if (!where.directive) {
            this.map.references.push({ file: where.file, line: index, ...where.kind, name: artifact, scope, owner: qualified, role: "kind" });
        }

        for (const entry of where.entries) {
            const text = line.slice(entry.start, entry.end);
            const colon = text.indexOf(":");
            const raw = colon < 0 ? "" : text.slice(colon + 1);
            const value = raw.trim();

            if (colon < 0 || /^["']/.test(value) || SlytherParser.NUMBER.test(value) || value === "true" || value === "false") {
                continue;
            }

            const type = value.endsWith("?") ? value.slice(0, -1).trim() : value;

            if (!SlytherParser.SYMBOL.test(type) || SlytherParser.TYPES.includes(type)) {
                continue;
            }

            const start = entry.start + colon + 1 + (raw.length - raw.trimStart().length);

            this.map.references.push({ file: where.file, line: index, start, end: start + type.length, name: type, scope, owner: qualified, role: "type" });
        }

        if (body === undefined) {
            return index;
        }

        if ("mode" in body) {
            this.readSource(qualified, body.mode, body.file, where);

            return index;
        }

        const read = this.body(lines, index, body.tail, artifact, qualified);

        this.declarations.get(qualified)!.content = read.content;
        written.last = read.end;

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
    private readSource(qualified: string, mode: "from" | "ref", file: string, where: SlytherParser["where"]): void {
        const resolved = resolve(this.script ? dirname(this.script) : process.cwd(), file);
        const location = this.script || process.cwd();

        if (where.path) {
            this.map.paths.push({ file: where.file, line: where.line, ...where.path, directive: mode, path: resolved });
        }

        if (statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
            if (mode === "from") {
                this.fail(`"${file}", the prose of "${qualified}", is a folder, which holds no text to embed with from. Point at it with ref instead.`);
                mode = "ref";
            }

            const declaration = this.declarations.get(qualified)!;

            declaration.content = "";
            declaration.source = { mode, path: relative(this.base, resolved) + sep, hash: SlytherFolderSource.hash(resolved) };

            return;
        }

        const text = this.read(resolved);

        if (text === undefined) {
            this.fail(`Cannot read "${file}", the prose of "${qualified}", from "${location}".`, where.path && { file: where.file, line: where.line, ...where.path });
        }

        const declaration = this.declarations.get(qualified)!;

        declaration.content = mode === "from" ? (text ?? "").replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd() : "";
        declaration.source = { mode, path: relative(this.base, resolved), hash: createHash("sha256").update(text ?? "").digest("hex") };
    }

    /**
     * Reads the body of a block from the tail of its opening line to its closing brace. Fenced and
     * inline code is opaque: it neither opens nor closes anything. A line that opens a block of a kind
     * the owner may contain is declared as its child and left out of the content; a backslash in front
     * of such a line keeps it as prose. Every reference the prose writes is recorded where it sits.
     */
    private body(
        lines: string[],
        index: number,
        tail: string,
        artifact: string,
        owner: string,
    ): { content: string; end: number } {
        const allowed = SlytherParser.CONTAINS[artifact] ?? [];
        const file = this.script;
        const scope = this.declarations.get(owner)?.scope ?? "";
        const body: string[] = [];
        let line = tail;
        /** The column the line starts at: the tail of the opening line starts after its brace. */
        let offset = lines[index]!.length - tail.length;
        let depth = 1;
        let fenced = false;

        for (;;) {
            this.at = { file, line: index, length: lines[index]!.length };

            if (SlytherParser.FENCE.test(line)) {
                fenced = !fenced;
            }

            if (!fenced && !SlytherParser.FENCE.test(line)) {
                let escapedAt = -1;

                if (SlytherParser.ESCAPE.test(line) && (SlytherParser.DECLARATION.test(line.replace("\\", "")) || SlytherParser.UNNAMED.test(line.replace("\\", "")))) {
                    escapedAt = line.indexOf("\\");
                    line = line.replace("\\", "");
                } else {
                    const nested = SlytherParser.DECLARATION.exec(line);

                    if (nested?.[5] || nested?.[7]) {
                        const [, child, name, args, qualifiers, open, rest, mode, path, both] = nested;

                        if (allowed.includes(child!)) {
                            index = this.declareAt(
                                lines,
                                index,
                                child!,
                                name!,
                                `${owner}::${name}`,
                                owner,
                                args ?? "",
                                qualifiers ?? "",
                                this.bodyOf(open, rest, mode, path, both, `${owner}::${name}`),
                                SlytherParser.whereOf(file, index, line, nested, { kind: 1, name: 2, args: [3], path: 8 }),
                            );

                            if (++index >= lines.length) {
                                this.fail(`Unterminated ${artifact} "${owner}".`);

                                return { content: StringUtils.dedent(body), end: lines.length - 1 };
                            }

                            line = lines[index]!;
                            offset = 0;
                            continue;
                        }

                        if (this.kinds.has(child!)) {
                            this.fail(`"${child}" cannot be declared inside ${artifact} "${owner}".`);
                        }
                    } else {
                        const unnamed = SlytherParser.UNNAMED.exec(line)?.[1];

                        if (unnamed && allowed.includes(unnamed)) {
                            this.fail(`The ${unnamed} block inside ${artifact} "${owner}" needs a name, as in "${unnamed} setup {".`);
                        }
                    }
                }

                const closed = this.closeOf(line, depth);

                this.references(closed.depth === 0 ? line.slice(0, closed.at) : line, file, index, offset, owner, scope, escapedAt);

                if (closed.depth === 0) {
                    if (line.slice(closed.at + 1).trim()) {
                        this.fail(`Unexpected text after the end of ${artifact} "${owner}".`, { file, line: index, start: offset + closed.at + 1, end: lines[index]!.length });
                    }

                    body.push(line.slice(0, closed.at));

                    return { content: StringUtils.dedent(body), end: index };
                }

                depth = closed.depth;
            }

            body.push(line);

            if (++index >= lines.length) {
                this.fail(`Unterminated ${artifact} "${owner}".`);

                return { content: StringUtils.dedent(body), end: lines.length - 1 };
            }

            line = lines[index]!;
            offset = 0;
        }
    }

    /**
     * Records every `#{Name}` the text writes outside inline code, at its columns in the line: the text
     * starts at the given column, and a backslash removed from it before the given column pushes
     * everything after it one column right.
     */
    private references(text: string, file: string, line: number, offset: number, owner: string, scope: string, escapedAt: number): void {
        const code = [...text.matchAll(SlytherParser.INLINE)].map((match) => [match.index!, match.index! + match[0].length] as const);

        for (const match of text.matchAll(SlytherParser.REFERENCE)) {
            const at = match.index!;

            if (code.some(([start, end]) => at >= start && at < end)) {
                continue;
            }

            const name = match[1]!;
            const start = offset + at + match[0].indexOf(name) + (escapedAt >= 0 && at >= escapedAt ? 1 : 0);

            this.map.references.push({ file, line, start, end: start + name.length, name, scope, owner, role: "reference" });
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

    private declare(name: string, artifact: string, scope: string, args: string, qualifiers: string, where: SlytherParser["where"]): void {
        if (this.declarations.has(name) && !this.implicit.delete(name)) {
            this.fail(`Duplicate declaration "${name}".`, { file: where.file, line: where.line, ...where.name });
        }

        this.declarations.set(name, { artifact, args, qualifiers, content: "", scope, where });

        if (this.owner !== undefined) {
            this.packaged.set(name, this.owner);
        }
    }

    /**
     * Reads the script at the resolved path into this one, once, however many times it is imported.
     * A package keeps its name while everything it pulls in is read, so whatever it declares is known
     * to be its, however many relative imports away it was written.
     */
    /**
     * Records who plays the role, as a `@role` line declares it: only the project binds roles, never a
     * package, which says what its work needs with `by` and leaves who does it to whoever uses it; a
     * role is one of the roles and is bound once; every option is a quoted string.
     */
    private bind(role: string, provider: string, list: string | undefined, file: string, line: number): void {
        if (this.owner !== undefined) {
            this.fail(`The package "${this.owner}" binds the role "${role}", but a package only says what its work needs with by: the project that uses it binds the roles.`);
            return;
        }

        if (!SlytherRole.isRole(role)) {
            this.fail(`"${role}" is not a role: the roles that write are ${SlytherRole.WRITERS.join(", ")}, and the ones that judge are ${SlytherRole.JUDGES.join(", ")}.`);
            return;
        }

        const known = this.roles.get(role);

        if (known) {
            this.fail(`The role "${role}" is bound twice: at ${known.file || "the script"}:${known.line + 1} and at ${file || "the script"}:${line + 1}.`);
            return;
        }

        const options: Record<string, string> = {};

        for (const entry of StringUtils.splitUnquoted(list ?? "", ",").filter((entry) => entry.trim().length > 0)) {
            const option = SlytherParser.OPTION.exec(entry);

            if (!option) {
                this.fail(`"${entry.trim()}" is not an option of the role "${role}": write it as name: "value".`);
                return;
            }

            if (option[1]! in options) {
                this.fail(`The role "${role}" is given the option "${option[1]}" twice.`);
                return;
            }

            options[option[1]!] = option[2] ?? option[3] ?? "";
        }

        this.roles.set(role, { provider, options, file, line });
    }

    private import(resolved: string, target: string, path: string, owner?: string): void {
        if (this.imported.has(resolved)) {
            return;
        }

        this.imported.add(resolved);

        const source = this.read(resolved);

        if (source === undefined) {
            this.fail(
                owner
                    ? `Cannot import the package "${owner}": nothing is installed at "${resolved}".`
                    : `Cannot import "${target}" from "${path || process.cwd()}".`,
            );

            return;
        }

        const outer = this.owner;

        this.owner = owner ?? outer;
        this.scan(source, resolved);
        this.owner = outer;
    }

    private checkParents(): void {
        for (const [name, declaration] of this.declarations) {
            const boundary = name.lastIndexOf("::");

            if (boundary >= 0 && !this.declarations.has(name.slice(0, boundary))) {
                this.fail(`Unknown parent "${name.slice(0, boundary)}" of "${name}".`, declaration.where && { file: declaration.where.file, line: declaration.where.line, ...declaration.where.name });
            }
        }
    }

    private argumentsOf(declaration: { artifact: string; args: string; scope: string; where?: SlytherParser["where"] }, owner: string): SlytherArtifact["args"] {
        return StringUtils.splitUnquoted(declaration.args, ",").flatMap((entry, position) => {
            const columns = declaration.where?.entries[position];
            const where = columns && declaration.where ? { file: declaration.where.file, line: declaration.where.line, ...columns } : SlytherParser.lineOf(declaration.where);
            const boundary = entry.indexOf(":");
            const name = (boundary < 0 ? entry : entry.slice(0, boundary)).trim();

            if (!SlytherParser.SYMBOL.test(name)) {
                this.fail(`Malformed argument "${entry.trim()}" of "${owner}".`, where);

                return [];
            }

            // A bare name gives no value: it is an operation narrowing to a param its kind declares.
            if (boundary < 0) {
                if (declaration.artifact !== "operation") {
                    this.fail(`Argument "${name}" of "${owner}" has no value: only an operation writes a bare name, to narrow to the params of its kind.`, where);

                    return [];
                }

                return [{ name, kind: "param" as const, value: "" }];
            }

            const value = this.valueOf(entry.slice(boundary + 1).trim(), name, owner, declaration.scope, where);

            return value ? [{ name, ...value }] : [];
        });
    }

    /** The bare words after the colon, in the order written; writing one twice throws. */
    private qualifiersOf(declaration: { qualifiers: string; where?: SlytherParser["where"] }, owner: string): string[] {
        const qualifiers = declaration.qualifiers
            .split(",")
            .map((qualifier) => qualifier.trim())
            .filter((qualifier) => qualifier.length > 0);
        const repeated = qualifiers.find((qualifier, index) => qualifiers.indexOf(qualifier) !== index);

        if (repeated) {
            this.fail(`Qualifier "${repeated}" is written twice on "${owner}".`, SlytherParser.lineOf(declaration.where));
        }

        return [...new Set(qualifiers)];
    }

    /** The value of an arg as written, or undefined when it is malformed and reading goes on. An unknown type is kept as written. */
    private valueOf(
        value: string,
        argument: string,
        owner: string,
        scope: string,
        where: { file: string; line: number; start: number; end: number } | undefined,
    ): Omit<SlytherArtifact["args"][number], "name"> | undefined {
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
            this.fail(`Malformed value "${value}" of argument "${argument}" of "${owner}".`, where);

            return undefined;
        }

        if (!SlytherParser.TYPES.includes(type) && !this.resolve(type, scope)) {
            this.fail(`Unknown type "${type}" of argument "${argument}" of "${owner}".`, where);
        }

        return optional ? { kind: "type", value: type, optional } : { kind: "type", value: type };
    }

    /**
     * The `kind:name` of everything the prose and the types of the args reference, sorted. A reference
     * in the prose that resolves to nothing is reported where it was written; a type that does was
     * reported when the arg was read, so it is only left out.
     */
    private referencesOf(declaration: { content: string; scope: string; source?: SlytherArtifact["source"]; where?: SlytherParser["where"] }, args: SlytherArtifact["args"], owner: string): string[] {
        const prose = declaration.source ? "" : declaration.content.replace(SlytherParser.CODE, "");
        const written = [...prose.matchAll(SlytherParser.REFERENCE)].map((match) => match[1]!);
        const typed = args.filter((arg) => arg.kind === "type" && !SlytherParser.TYPES.includes(String(arg.value))).map((arg) => String(arg.value));
        const references: string[] = [];

        for (const name of written) {
            const resolved = this.resolve(name, declaration.scope);

            if (!resolved) {
                const reference = this.map.references.find((candidate) => candidate.owner === owner && candidate.name === name && candidate.role === "reference");

                this.fail(`Unknown reference "${name}".`, reference ?? SlytherParser.lineOf(declaration.where));
                continue;
            }

            references.push(`${this.declarations.get(resolved)!.artifact}:${resolved}`);
        }

        for (const name of typed) {
            const resolved = this.resolve(name, declaration.scope);

            if (resolved) {
                references.push(`${this.declarations.get(resolved)!.artifact}:${resolved}`);
            }
        }

        return [...new Set(references)].sort();
    }

    /** Looks the name up in the scope, then in each enclosing scope, then globally. */
    private resolve(name: string, scope: string): string | undefined {
        return SlytherParser.lookup(name, scope, (candidate) => this.declarations.has(candidate));
    }

    /**
     * The kind a declaration opens with, looked up as a reference is: in the namespace it is written
     * in, then in each enclosing one, then globally. A kind a package declares is named inside that
     * package, so what it declares is reached by opening it with `@use` or by writing it qualified.
     */
    private resolveKind(name: string, scope: string): string | undefined {
        return SlytherParser.lookup(name, scope, (candidate) => this.kinds.has(candidate));
    }

    /** Why a kind was not found: unknown, or declared somewhere this declaration cannot see it. */
    private unknownKind(name: string, owner: string): string {
        const elsewhere = [...this.kinds].filter((candidate) => candidate.endsWith(`::${name}`));

        if (elsewhere.length === 0) {
            return `Unknown artifact "${name}" of "${owner}".`;
        }

        return `Unknown artifact "${name}" of "${owner}": ${elsewhere.map((candidate) => `"${candidate}"`).join(" and ")} declare${elsewhere.length > 1 ? "" : "s"} it elsewhere, so write it qualified or open its namespace with @use.`;
    }

    /** Looks a name up in the scope, then in each enclosing scope, then globally, among whatever the test knows. */
    private static lookup(name: string, scope: string, has: (candidate: string) => boolean): string | undefined {
        for (let prefix = scope; ; ) {
            const candidate = prefix ? `${prefix}::${name}` : name;

            if (has(candidate)) {
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
