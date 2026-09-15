// Imports
import type { SlytherArtifact } from "./SlytherArtifact.class.ts";

export class ParsedSlytherScript {
    constructor(
        readonly artifacts: SlytherArtifact[],
        readonly closureHashes: Map<string, string>,
    ) {}
}
