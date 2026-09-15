// Imports
import { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";
import type { SlytherScript } from "./SlytherScript.class.ts";

export class SlytherParser {
    private static readonly DECLARATION =
        /^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*(\{)?\s*$/;

    parse(script: SlytherScript): ParsedSlytherScript {
        const lines = script.source.split("\n");
        const artifacts: SlytherArtifact[] = [];

        for (let index = 0; index < lines.length; index++) {
            const declaration = SlytherParser.DECLARATION.exec(lines[index] ?? "");
            if (!declaration) {
                continue;
            }

            const [, artifact, name, open] = declaration;
            let content = "";

            if (open) {
                const body: string[] = [];
                let depth = 1;

                while (++index < lines.length) {
                    const line = lines[index] ?? "";
                    depth += (line.match(/\{/g)?.length ?? 0);
                    depth -= (line.match(/\}/g)?.length ?? 0);
                    if (depth === 0) {
                        break;
                    }
                    body.push(line);
                }

                if (depth !== 0) {
                    throw new Error(`Unterminated ${artifact} "${name}".`);
                }

                content = body.join("\n").trim();
            }

            artifacts.push(new SlytherArtifact(artifact!, name!, content));
        }

        return new ParsedSlytherScript(artifacts);
    }
}
