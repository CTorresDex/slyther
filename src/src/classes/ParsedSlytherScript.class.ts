// Imports
import type { SlytherArtifact } from "./SlytherArtifact.class.ts";

export class ParsedSlytherScript {
    constructor(
        readonly artifacts: SlytherArtifact[],
        readonly closureHashes: Map<string, string>,
        readonly scopeHashes: Map<string, string>,
        /** The language declared by the `@lang` line, if any. */
        readonly lang?: string,
    ) {}

    /** The parsed script as plain JSON, with the hashes as objects keyed by `kind:name`. */
    toJSON(): {
        artifacts: SlytherArtifact[];
        closureHashes: Record<string, string>;
        scopeHashes: Record<string, string>;
        lang?: string;
    } {
        return {
            artifacts: this.artifacts,
            closureHashes: Object.fromEntries(this.closureHashes),
            scopeHashes: Object.fromEntries(this.scopeHashes),
            lang: this.lang,
        };
    }
}
