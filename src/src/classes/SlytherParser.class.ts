// Imports
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherClosureHasher } from "./SlytherClosureHasher.class.ts";
import type { SlytherScript } from "./SlytherScript.class.ts";

export class SlytherParser {
    private static readonly ARTIFACT = /^\s*@artifact\s+([A-Za-z_][\w-]*)\s*$/;
    private static readonly IMPORT = /^\s*@import\s+["']([^"']+)["']\s*$/;
    private static readonly USE = /^\s*@use\s+([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*$/;
    private static readonly DECLARATION =
        /^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*(?:\((.*)\))?\s*(\{)?\s*$/;
    private static readonly REFERENCE =
        /(?<!\\)#\{\s*([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*\}/g;
    private static readonly SYMBOL = /^[A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*$/;
    private static readonly NUMBER = /^-?\d+(?:\.\d+)?$/;

    private kinds = new Set<string>();
    private implicit = new Set<string>();
    private imported = new Set<string>();

    parse(script: SlytherScript): ParsedSlytherScript {
        const declarations = new Map<
            string,
            { artifact: string; args: string; content: string; scope: string }
        >();

        this.kinds = new Set(["artifact", "namespace"]);
        this.implicit = new Set();
        this.imported = script.path ? new Set([resolve(script.path)]) : new Set();

        this.scan(script.source, script.path, declarations);

        this.checkParents(declarations);

        const artifacts = [...declarations].map(([name, declaration]) => {
            const args = this.argumentsOf(declaration, name, declarations);

            return new SlytherArtifact(
                declaration.artifact,
                name,
                args,
                declaration.content,
                this.referencesOf(declaration, args, declarations),
            );
        });

        return new ParsedSlytherScript(artifacts, new SlytherClosureHasher().hash(artifacts));
    }

    private scan(
        source: string,
        path: string,
        declarations: Map<
            string,
            { artifact: string; args: string; content: string; scope: string }
        >,
    ): void {
        const lines = source.split("\n");
        let scope = "";

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index] ?? "";
            const imported = SlytherParser.IMPORT.exec(line);

            if (imported) {
                this.import(imported[1]!, path, declarations);
                continue;
            }

            const kind = SlytherParser.ARTIFACT.exec(line);

            if (kind) {
                this.declare(kind[1]!, "artifact", "", declarations);
                this.kinds.add(kind[1]!);
                continue;
            }

            const use = SlytherParser.USE.exec(line);

            if (use) {
                scope = use[1]!;

                if (!declarations.has(scope)) {
                    declarations.set(scope, {
                        artifact: "namespace",
                        args: "",
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

            const [, artifact, name, args, open] = declaration;
            const body: string[] = [];
            let depth = open ? 1 : 0;

            while (depth > 0 && ++index < lines.length) {
                const inner = lines[index] ?? "";
                depth += inner.match(/\{/g)?.length ?? 0;
                depth -= inner.match(/\}/g)?.length ?? 0;
                if (depth > 0) {
                    body.push(inner);
                }
            }

            if (depth !== 0) {
                throw new Error(`Unterminated ${artifact} "${name}".`);
            }

            const qualified = scope ? `${scope}::${name}` : name!;

            if (!this.kinds.has(artifact!)) {
                throw new Error(`Unknown artifact "${artifact}" of "${qualified}".`);
            }

            this.declare(qualified, artifact!, scope, declarations, args ?? "", body.join("\n").trim());
        }
    }

    private declare(
        name: string,
        artifact: string,
        scope: string,
        declarations: Map<
            string,
            { artifact: string; args: string; content: string; scope: string }
        >,
        args = "",
        content = "",
    ): void {
        if (declarations.has(name) && !this.implicit.delete(name)) {
            throw new Error(`Duplicate declaration "${name}".`);
        }

        declarations.set(name, { artifact, args, content, scope });
    }

    private import(
        target: string,
        path: string,
        declarations: Map<
            string,
            { artifact: string; args: string; content: string; scope: string }
        >,
    ): void {
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

        this.scan(source, resolved, declarations);
    }

    private checkParents(
        declarations: Map<string, { artifact: string; args: string; content: string; scope: string }>,
    ): void {
        for (const name of declarations.keys()) {
            const boundary = name.lastIndexOf("::");

            if (boundary >= 0 && !declarations.has(name.slice(0, boundary))) {
                throw new Error(`Unknown parent "${name.slice(0, boundary)}" of "${name}".`);
            }
        }
    }

    private argumentsOf(
        declaration: { args: string; scope: string },
        owner: string,
        declarations: Map<string, { artifact: string; args: string; content: string; scope: string }>,
    ): SlytherArtifact["args"] {
        return this.entriesOf(declaration.args).map((entry) => {
            const boundary = entry.indexOf(":");
            const name = boundary < 0 ? "" : entry.slice(0, boundary).trim();

            if (!SlytherParser.SYMBOL.test(name)) {
                throw new Error(`Malformed argument "${entry.trim()}" of "${owner}".`);
            }

            const value = entry.slice(boundary + 1).trim();

            return { name, ...this.valueOf(value, name, owner, declaration.scope, declarations) };
        });
    }

    private entriesOf(text: string): string[] {
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
            } else if (character === ",") {
                entries.push(current);
                current = "";
                continue;
            }

            current += character;
        }

        entries.push(current);

        return entries.filter((entry) => entry.trim().length > 0);
    }

    private valueOf(
        value: string,
        argument: string,
        owner: string,
        scope: string,
        declarations: Map<string, { artifact: string; args: string; content: string; scope: string }>,
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

        if (!this.resolve(value, scope, declarations)) {
            throw new Error(`Unknown type "${value}" of argument "${argument}" of "${owner}".`);
        }

        return { kind: "type", value };
    }

    private referencesOf(
        declaration: { content: string; scope: string },
        args: SlytherArtifact["args"],
        declarations: Map<string, { artifact: string; args: string; content: string; scope: string }>,
    ): string[] {
        const written = [
            ...[...declaration.content.matchAll(SlytherParser.REFERENCE)].map((match) => match[1]!),
            ...args.filter((arg) => arg.kind === "type").map((arg) => String(arg.value)),
        ];

        const references = written.map((name) => {
            const resolved = this.resolve(name, declaration.scope, declarations);

            if (!resolved) {
                throw new Error(`Unknown reference "${name}".`);
            }

            return `${declarations.get(resolved)!.artifact}:${resolved}`;
        });

        return [...new Set(references)].sort();
    }

    private resolve(
        name: string,
        scope: string,
        declarations: Map<string, { artifact: string; args: string; content: string; scope: string }>,
    ): string | undefined {
        const scoped = scope ? `${scope}::${name}` : name;

        if (declarations.has(scoped)) {
            return scoped;
        }

        return declarations.has(name) ? name : undefined;
    }
}
