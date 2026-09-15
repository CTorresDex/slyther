// Imports
import type { SlytherArtifact } from "./SlytherArtifact.class.ts";

export class ParsedSlytherScript {
    constructor(
        readonly artifacts: SlytherArtifact[],
        readonly closureHashes: Map<string, string>,
    ) {}

    /** The parsed script as plain JSON, with the closure hashes as an object keyed by `kind:name`. */
    toJSON(): { artifacts: SlytherArtifact[]; closureHashes: Record<string, string> } {
        return {
            artifacts: this.artifacts,
            closureHashes: Object.fromEntries(this.closureHashes),
        };
    }
}
