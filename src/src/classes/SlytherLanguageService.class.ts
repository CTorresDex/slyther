// Imports
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import type { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherArtifactKind } from "./SlytherArtifactKind.class.ts";
import { SlytherParser } from "./SlytherParser.class.ts";
import { SlytherProject } from "./SlytherProject.class.ts";
import { SlytherRunScript } from "./SlytherRunScript.class.ts";
import { SlytherScript } from "./SlytherScript.class.ts";
import { SlytherSourceMap } from "./SlytherSourceMap.class.ts";

export class SlytherLanguageService {
    /** The directives a line may open with, outside every block. */
    private static readonly DIRECTIVES = ["@artifact", "@trait", "@import", "@use", "@lang", "@run"];
    /** The qualifiers there are: an operation or a rule is deterministic, a rule is negative. */
    private static readonly QUALIFIERS = ["deterministic", "negative"];
    /** How many lines of prose a hover shows before cutting it short. */
    private static readonly PREVIEW = 12;
    /** `#{partial` up to the cursor: a reference being written. */
    private static readonly REFERENCE = /#\{\s*([A-Za-z_][\w:-]*)?$/;
    /** `kind name (args): partial` up to the cursor: a qualifier being written. */
    private static readonly QUALIFIER = /^\s*@?[A-Za-z_][\w-]*\s+[A-Za-z_][\w:-]*\s*(?:\([^)]*\))?\s*:\s*(?:[A-Za-z_][\w-]*\s*,\s*)*([A-Za-z_][\w-]*)?$/;
    /** `kind name (arg: partial` up to the cursor: the type of an arg being written. */
    private static readonly TYPE = /\([^)]*?[A-Za-z_][\w-]*\s*:\s*([A-Za-z_][\w:-]*)?$/;
    /** `operation name (a, partial` up to the cursor: a param an operation is narrowing to. */
    private static readonly PARAM = /^\s*operation\s+[A-Za-z_][\w:-]*\s*\((?:[^):]*,)?\s*([A-Za-z_][\w-]*)?$/;
    /** `@use partial` up to the cursor. */
    private static readonly USE = /^\s*@use\s+([A-Za-z_][\w:-]*)?$/;
    /** Only whitespace, or a word after it, up to the cursor: a line that may open a block. */
    private static readonly OPENING = /^\s*(@?[A-Za-z_][\w-]*)?$/;
    /** A quoted name in what the grouping of kinds and scripts reports, which is where it is reported. */
    private static readonly QUOTED = /"([^"]+)"/g;

    /** Everything known about a project, kept until something changes. */
    private analyses = new Map<string, { parsed: ParsedSlytherScript; map: SlytherSourceMap }>();

    constructor(
        /** What the editor holds for a path, or undefined when the file is not open, so the disk is read instead. */
        private readonly documents: { get(path: string): string | undefined },
    ) {}

    /** Forgets everything analyzed, since something changed. */
    invalidate(): void {
        this.analyses = new Map();
    }

    /**
     * Everything known about the project of the file: the nearest entry point up the tree whose
     * imports reach the file, or the file on its own when none does. The project is parsed leniently,
     * and, when it parses, its kinds and scripts are grouped too, so what is wrong with their shape is
     * reported on the declaration it names.
     */
    analyze(file: string): { parsed: ParsedSlytherScript; map: SlytherSourceMap } {
        for (const main of this.mainsAbove(file)) {
            const analysis = this.analysis(main);

            if (analysis.map.files.includes(file)) {
                return analysis;
            }
        }

        return this.analysis(file);
    }

    /** Every entry point from the folder of the file up to the root, nearest first. */
    private mainsAbove(file: string): string[] {
        const mains: string[] = [];

        for (let folder = dirname(file); ; folder = dirname(folder)) {
            const main = join(folder, SlytherProject.MAIN);

            if (this.documents.get(main) !== undefined || existsSync(main)) {
                mains.push(main);
            }

            if (dirname(folder) === folder) {
                return mains;
            }
        }
    }

    private analysis(root: string): { parsed: ParsedSlytherScript; map: SlytherSourceMap } {
        const known = this.analyses.get(root);

        if (known) {
            return known;
        }

        const parser = new SlytherParser({ lenient: true, read: (path) => this.documents.get(path) });
        const parsed = parser.parse(new SlytherScript(this.read(root), root));
        const analysis = { parsed, map: parser.map };

        if (!analysis.map.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
            this.group(analysis);
        }

        this.analyses.set(root, analysis);

        return analysis;
    }

    /** What the editor holds for the path, else what the disk does, else nothing. */
    private read(path: string): string {
        const open = this.documents.get(path);

        if (open !== undefined) {
            return open;
        }

        try {
            return readFileSync(path, "utf-8");
        } catch {
            return "";
        }
    }

    /** Groups the kinds and the scripts of a project that parsed, reporting what is wrong with their shape and their warnings. */
    private group({ parsed, map }: { parsed: ParsedSlytherScript; map: SlytherSourceMap }): void {
        const report = (message: string, severity: "error" | "warning") => {
            const named = [...message.matchAll(SlytherLanguageService.QUOTED)].map((match) => map.declarationOf(match[1]!)).find((declaration) => declaration);
            const at = named ? { file: named.file, line: named.line, ...named.at } : { file: map.files[0] ?? "", line: 0, start: 0, end: 0 };

            map.diagnostics.push({ ...at, message, severity });
        };

        try {
            for (const kind of SlytherArtifactKind.of(parsed)) {
                for (const warning of kind.warnings) {
                    report(warning, "warning");
                }
            }
        } catch (error) {
            report(error instanceof Error ? error.message : String(error), "error");
        }

        try {
            SlytherRunScript.of(parsed);
        } catch (error) {
            report(error instanceof Error ? error.message : String(error), "error");
        }
    }

    /** What is wrong in the file, in the order found. */
    diagnostics(file: string): SlytherSourceMap["diagnostics"] {
        return this.analyze(file).map.diagnostics.filter((diagnostic) => diagnostic.file === file);
    }

    /**
     * The declarations of the file as a tree: a `Parent::child` declared in the same file sits under
     * its parent, named by what follows the parent's name.
     */
    symbols(file: string): SlytherLanguageService["symbol"][] {
        const { map } = this.analyze(file);
        const declarations = map.declarations.filter((declaration) => declaration.file === file);
        const symbolOf = (declaration: SlytherSourceMap["declarations"][number], parent?: string): SlytherLanguageService["symbol"] => ({
            name: parent ? declaration.name.slice(parent.length + 2) : declaration.name,
            artifact: declaration.artifact,
            line: declaration.line,
            last: declaration.last,
            at: declaration.at,
            children: declarations
                .filter((child) => SlytherLanguageService.parentOf(child.name) === declaration.name && child !== declaration)
                .map((child) => symbolOf(child, declaration.name)),
        });

        return declarations
            .filter((declaration) => !declarations.some((parent) => parent !== declaration && parent.name === SlytherLanguageService.parentOf(declaration.name)))
            .map((declaration) => symbolOf(declaration));
    }

    /** The shape of a symbol: never a value, only the type of the field. */
    private declare symbol: {
        name: string;
        artifact: string;
        line: number;
        last: number;
        at: { start: number; end: number };
        children: SlytherLanguageService["symbol"][];
    };

    /** Every declaration whose name holds the query, ignoring case, in every file of the project of the file. */
    workspaceSymbols(file: string, query: string): { name: string; artifact: string; file: string; line: number; at: { start: number; end: number } }[] {
        const needle = query.toLowerCase();

        return this.analyze(file)
            .map.declarations.filter((declaration) => declaration.name.toLowerCase().includes(needle))
            .map((declaration) => ({ name: declaration.name, artifact: declaration.artifact, file: declaration.file, line: declaration.line, at: declaration.at }));
    }

    /** The lines every block of the file may fold, from the line it opens on to the one before it closes. */
    folding(file: string): { start: number; end: number }[] {
        return this.analyze(file)
            .map.declarations.filter((declaration) => declaration.file === file && declaration.last > declaration.line + 1)
            .map((declaration) => ({ start: declaration.line, end: declaration.last - 1 }));
    }

    /**
     * Where what is written at the position is declared: the name of a declaration is its own, a
     * reference goes to what it resolves to, and a path goes to the file it names, when it is one.
     */
    definition(file: string, line: number, character: number): { file: string; line: number; start: number; end: number }[] {
        const { map } = this.analyze(file);
        const found = map.at(file, line, character);

        if (!found) {
            return [];
        }

        if (found.kind === "path") {
            return statSync(found.path.path, { throwIfNoEntry: false })?.isFile() ? [{ file: found.path.path, line: 0, start: 0, end: 0 }] : [];
        }

        const name = found.kind === "declaration" ? found.declaration.name : found.reference.target;

        return name === undefined ? [] : SlytherLanguageService.locationsOf(map, name);
    }

    /** Where the name is declared, every time it is. */
    private static locationsOf(map: SlytherSourceMap, name: string): { file: string; line: number; start: number; end: number }[] {
        return map.declarations.filter((declaration) => declaration.name === name).map((declaration) => ({ file: declaration.file, line: declaration.line, ...declaration.at }));
    }

    /**
     * Everywhere the declaration written at the position, or the one the reference at it resolves to,
     * is referenced: in prose, as the type of an arg, or as the kind that opens a declaration, and
     * where it is declared when asked.
     */
    references(file: string, line: number, character: number, declaration: boolean): { file: string; line: number; start: number; end: number }[] {
        const { map } = this.analyze(file);
        const found = map.at(file, line, character);
        const name = found?.kind === "declaration" ? found.declaration.name : found?.kind === "reference" ? found.reference.target : undefined;

        if (name === undefined) {
            return [];
        }

        return [
            ...(declaration ? SlytherLanguageService.locationsOf(map, name) : []),
            ...map.references.filter((reference) => reference.target === name).map((reference) => ({ file: reference.file, line: reference.line, start: reference.start, end: reference.end })),
        ];
    }

    /**
     * What to show over the position: the head of the declaration written or referenced there and the
     * start of its prose, as markdown, or the file a path names.
     */
    hover(file: string, line: number, character: number): { markdown: string; start: number; end: number } | undefined {
        const { parsed, map } = this.analyze(file);
        const found = map.at(file, line, character);

        if (!found) {
            return undefined;
        }

        if (found.kind === "path") {
            return { markdown: `\`${found.path.path}\`${existsSync(found.path.path) ? "" : " *(not found)*"}`, start: found.path.start, end: found.path.end };
        }

        const span = found.kind === "declaration" ? found.declaration.at : found.reference;
        const name = found.kind === "declaration" ? found.declaration.name : found.reference.target;
        const artifact = parsed.artifacts.find((candidate) => candidate.name === name);

        if (!artifact) {
            return undefined;
        }

        return { markdown: SlytherLanguageService.describe(artifact), start: span.start, end: span.end };
    }

    /** The head of the artifact as it is written, then its prose cut short, as markdown. */
    private static describe(artifact: SlytherArtifact): string {
        const args = artifact.args.map((arg) =>
            arg.kind === "param" ? arg.name : `${arg.name}: ${arg.kind === "string" ? JSON.stringify(arg.value) : String(arg.value)}${arg.optional ? "?" : ""}`,
        );
        const head = [
            artifact.artifact === "artifact" ? "@artifact" : artifact.artifact === SlytherParser.RUN_KIND ? "@run" : artifact.artifact,
            artifact.name,
            ...(args.length ? [`(${args.join(", ")})`] : []),
            ...(artifact.qualifiers.length ? [`: ${artifact.qualifiers.join(", ")}`] : []),
        ].join(" ");
        const lines = artifact.prose.split("\n");
        const preview = lines.slice(0, SlytherLanguageService.PREVIEW).join("\n") + (lines.length > SlytherLanguageService.PREVIEW ? "\n…" : "");

        return ["```slyther", head, "```", ...(preview.trim() ? ["", preview] : [])].join("\n");
    }

    /**
     * What may be written at the position, given the line up to it: a reference after `#{`, a
     * qualifier after the colon of a declaration, a type after the colon of an arg, a namespace after
     * `@use`, or, on a line that holds nothing else yet, the kinds the block around it may contain, or
     * the kinds and the directives a script may open with when it is inside no block. Every item
     * replaces the columns given, what was written of it so far.
     */
    completions(file: string, line: number, text: string): { label: string; detail?: string; start: number; end: number; kind: "reference" | "kind" | "qualifier" | "type" | "namespace" | "directive" | "param" }[] {
        const { parsed, map } = this.analyze(file);
        const enclosing = map.enclosing(file, line);
        const scope = enclosing?.scope ?? "";
        const reference = SlytherLanguageService.REFERENCE.exec(text);

        if (reference) {
            const start = text.length - (reference[1]?.length ?? 0);

            return SlytherLanguageService.visible(parsed, SlytherLanguageService.scopeChain(scope)).map(({ name, artifact }) => ({ label: name, detail: artifact, start, end: text.length, kind: "reference" }));
        }

        const use = SlytherLanguageService.USE.exec(text);

        if (use) {
            const start = text.length - (use[1]?.length ?? 0);

            return parsed.artifacts.filter((artifact) => artifact.artifact === "namespace").map((artifact) => ({ label: artifact.name, detail: "namespace", start, end: text.length, kind: "namespace" }));
        }

        const param = SlytherLanguageService.PARAM.exec(text);

        if (param) {
            const start = text.length - (param[1]?.length ?? 0);
            const owner = map.enclosing(file, line, true);
            const kind = parsed.artifacts.find((artifact) => artifact.artifact === "artifact" && artifact.name === owner?.name);
            const written = text.slice(text.indexOf("(") + 1);

            return [
                { name: "id", type: "string" },
                ...(kind?.args.filter((arg) => arg.kind === "type").map((arg) => ({ name: arg.name, type: `${String(arg.value)}${arg.optional ? "?" : ""}` })) ?? []),
                ...(/^\s*operation\s+update\b/.test(text) ? [{ name: "errors", type: "string" }] : []),
            ]
                .filter((candidate) => !new RegExp(`\\b${candidate.name}\\s*,`).test(written))
                .map((candidate) => ({ label: candidate.name, detail: candidate.type, start, end: text.length, kind: "param" as const }));
        }

        const type = SlytherLanguageService.TYPE.exec(text);

        if (type) {
            const start = text.length - (type[1]?.length ?? 0);
            const declared = enclosing ? SlytherLanguageService.parentOf(enclosing.name) : "";

            return [
                ...SlytherParser.TYPES.map((builtin) => ({ label: builtin, detail: "type", start, end: text.length, kind: "type" as const })),
                ...SlytherLanguageService.visible(parsed, SlytherLanguageService.scopeChain(declared)).map(({ name, artifact }) => ({ label: name, detail: artifact, start, end: text.length, kind: "type" as const })),
            ];
        }

        const qualifier = SlytherLanguageService.QUALIFIER.exec(text);

        if (qualifier) {
            const start = text.length - (qualifier[1]?.length ?? 0);

            return SlytherLanguageService.QUALIFIERS.map((label) => ({ label, detail: "qualifier", start, end: text.length, kind: "qualifier" }));
        }

        const opening = SlytherLanguageService.OPENING.exec(text);

        if (!opening) {
            return [];
        }

        const start = text.length - (opening[1]?.length ?? 0);
        const owner = map.enclosing(file, line, true);
        const kinds = owner
            ? [...(SlytherParser.CONTAINS[owner.artifact] ?? [])]
            : parsed.artifacts.filter((artifact) => artifact.artifact === "artifact").map((artifact) => artifact.name);

        return [
            ...kinds.map((label) => ({ label, detail: "kind", start, end: text.length, kind: "kind" as const })),
            ...(owner ? [] : SlytherLanguageService.DIRECTIVES.map((label) => ({ label, detail: "directive", start, end: text.length, kind: "directive" as const }))),
        ];
    }

    /** The scope and every scope enclosing it, innermost first, ending with the global one. */
    private static scopeChain(scope: string): string[] {
        const chain: string[] = [];

        for (let prefix = scope; ; ) {
            chain.push(prefix);

            if (!prefix) {
                return chain;
            }

            prefix = SlytherLanguageService.parentOf(prefix);
        }
    }

    /**
     * Every declared name as it may be written from the given scopes: its full name, and, for a name
     * inside one of the scopes, what follows that scope. A shorter form shadowed by a nearer scope is
     * left out, as it would resolve to the nearer one.
     */
    private static visible(parsed: ParsedSlytherScript, scopes: string[]): { name: string; artifact: string }[] {
        const names = new Map(parsed.artifacts.map((artifact) => [artifact.name, artifact.artifact]));
        const visible = new Map<string, string>();
        const resolve = (name: string): string | undefined => {
            for (const scope of scopes) {
                const candidate = scope ? `${scope}::${name}` : name;

                if (names.has(candidate)) {
                    return candidate;
                }
            }

            return undefined;
        };

        for (const [name, artifact] of names) {
            visible.set(name, artifact);

            for (const scope of scopes) {
                if (scope && name.startsWith(`${scope}::`) && resolve(name.slice(scope.length + 2)) === name) {
                    visible.set(name.slice(scope.length + 2), artifact);
                }
            }
        }

        return [...visible].map(([name, artifact]) => ({ name, artifact })).sort((a, b) => a.name.localeCompare(b.name));
    }

    /** What comes before the last `::` of a name, or nothing. */
    private static parentOf(name: string): string {
        const boundary = name.lastIndexOf("::");

        return boundary < 0 ? "" : name.slice(0, boundary);
    }
}
