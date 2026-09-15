// Imports
import { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherClosureHasher } from "./SlytherClosureHasher.class.ts";
import type { SlytherScript } from "./SlytherScript.class.ts";

export class SlytherParser {
    private static readonly DECLARATION =
        /^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*(\{)?\s*$/;
    private static readonly REFERENCE = /(?<!\\)#\{\s*([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*\}/g;

    parse(script: SlytherScript): ParsedSlytherScript {
        const declarations = this.scan(script.source);

        this.checkParents(declarations);

        const artifacts = [...declarations].map(
            ([name, declaration]) =>
                new SlytherArtifact(
                    declaration.artifact,
                    name,
                    declaration.content,
                    this.referencesOf(declaration.content, declarations),
                ),
        );

        return new ParsedSlytherScript(artifacts, new SlytherClosureHasher().hash(artifacts));
    }

    private scan(source: string): Map<string, { artifact: string; content: string }> {
        const lines = source.split("\n");
        const declarations = new Map<string, { artifact: string; content: string }>();

        for (let index = 0; index < lines.length; index++) {
            const declaration = SlytherParser.DECLARATION.exec(lines[index] ?? "");
            if (!declaration) {
                continue;
            }

            const [, artifact, name, open] = declaration;
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

            declarations.set(name!, { artifact: artifact!, content: body.join("\n").trim() });
        }

        return declarations;
    }

    private checkParents(
        declarations: Map<string, { artifact: string; content: string }>,
    ): void {
        for (const name of declarations.keys()) {
            const boundary = name.lastIndexOf("::");

            if (boundary >= 0 && !declarations.has(name.slice(0, boundary))) {
                throw new Error(`Unknown parent "${name.slice(0, boundary)}" of "${name}".`);
            }
        }
    }

    private referencesOf(
        content: string,
        declarations: Map<string, { artifact: string; content: string }>,
    ): string[] {
        const references = [...content.matchAll(SlytherParser.REFERENCE)].map((match) => {
            const name = match[1]!;
            const declaration = declarations.get(name);

            if (!declaration) {
                throw new Error(`Unknown reference "${name}".`);
            }

            return `${declaration.artifact}:${name}`;
        });

        return [...new Set(references)].sort();
    }
}
