// Imports
import { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherClosureHasher } from "./SlytherClosureHasher.class.ts";
import type { SlytherScript } from "./SlytherScript.class.ts";

export class SlytherParser {
    private static readonly DECLARATION =
        /^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*(?:\((.*)\))?\s*(\{)?\s*$/;
    private static readonly REFERENCE =
        /(?<!\\)#\{\s*([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*\}/g;
    private static readonly SYMBOL = /^[A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*$/;
    private static readonly NUMBER = /^-?\d+(?:\.\d+)?$/;

    parse(script: SlytherScript): ParsedSlytherScript {
        const declarations = this.scan(script.source);

        this.checkParents(declarations);

        const artifacts = [...declarations].map(([name, declaration]) => {
            const args = this.argumentsOf(declaration.args, name, declarations);

            return new SlytherArtifact(
                declaration.artifact,
                name,
                args,
                declaration.content,
                this.referencesOf(declaration.content, args, declarations),
            );
        });

        return new ParsedSlytherScript(artifacts, new SlytherClosureHasher().hash(artifacts));
    }

    private scan(
        source: string,
    ): Map<string, { artifact: string; args: string; content: string }> {
        const lines = source.split("\n");
        const declarations = new Map<
            string,
            { artifact: string; args: string; content: string }
        >();

        for (let index = 0; index < lines.length; index++) {
            const declaration = SlytherParser.DECLARATION.exec(lines[index] ?? "");
            if (!declaration) {
                continue;
            }

            const [, artifact, name, args, open] = declaration;
            const body: string[] = [];
            let depth = open ? 1 : 0;

            while (depth > 0 && ++index < lines.length) {
                const line = lines[index] ?? "";
                depth += line.match(/\{/g)?.length ?? 0;
                depth -= line.match(/\}/g)?.length ?? 0;
                if (depth > 0) {
                    body.push(line);
                }
            }

            if (depth !== 0) {
                throw new Error(`Unterminated ${artifact} "${name}".`);
            }

            declarations.set(name!, {
                artifact: artifact!,
                args: args ?? "",
                content: body.join("\n").trim(),
            });
        }

        return declarations;
    }

    private checkParents(
        declarations: Map<string, { artifact: string; args: string; content: string }>,
    ): void {
        for (const name of declarations.keys()) {
            const boundary = name.lastIndexOf("::");

            if (boundary >= 0 && !declarations.has(name.slice(0, boundary))) {
                throw new Error(`Unknown parent "${name.slice(0, boundary)}" of "${name}".`);
            }
        }
    }

    private argumentsOf(
        text: string,
        owner: string,
        declarations: Map<string, { artifact: string; args: string; content: string }>,
    ): SlytherArtifact["args"] {
        return this.entriesOf(text).map((entry) => {
            const boundary = entry.indexOf(":");
            const name = boundary < 0 ? "" : entry.slice(0, boundary).trim();

            if (!SlytherParser.SYMBOL.test(name)) {
                throw new Error(`Malformed argument "${entry.trim()}" of "${owner}".`);
            }

            return {
                name,
                ...this.valueOf(entry.slice(boundary + 1).trim(), name, owner, declarations),
            };
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
        declarations: Map<string, { artifact: string; args: string; content: string }>,
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

        if (!declarations.has(value)) {
            throw new Error(`Unknown type "${value}" of argument "${argument}" of "${owner}".`);
        }

        return { kind: "type", value };
    }

    private referencesOf(
        content: string,
        args: SlytherArtifact["args"],
        declarations: Map<string, { artifact: string; args: string; content: string }>,
    ): string[] {
        const references = [...content.matchAll(SlytherParser.REFERENCE)].map((match) => {
            const name = match[1]!;

            if (!declarations.has(name)) {
                throw new Error(`Unknown reference "${name}".`);
            }

            return this.keyOf(name, declarations);
        });

        const types = args
            .filter((arg) => arg.kind === "type")
            .map((arg) => this.keyOf(String(arg.value), declarations));

        return [...new Set([...references, ...types])].sort();
    }

    private keyOf(
        name: string,
        declarations: Map<string, { artifact: string; args: string; content: string }>,
    ): string {
        return `${declarations.get(name)!.artifact}:${name}`;
    }
}
