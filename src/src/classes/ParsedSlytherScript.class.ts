// Imports
import type { SlytherArtifact } from "./SlytherArtifact.class.ts";
import type { SlytherRole } from "./SlytherRole.class.ts";

export class ParsedSlytherScript {
    constructor(
        readonly artifacts: SlytherArtifact[],
        readonly closureHashes: Map<string, string>,
        readonly scopeHashes: Map<string, string>,
        /** The language declared by the `@lang` line, if any. */
        readonly lang?: string,
        /** The package every artifact an `@import` of a package brought in came from, keyed by name. */
        readonly packages: Map<string, string> = new Map(),
        /** Who plays every role the project binds with `@role`, keyed by the role. */
        readonly roles: Map<string, SlytherRole["binding"]> = new Map(),
    ) {}

    /** The parsed script as plain JSON, with the hashes as objects keyed by `kind:name`. */
    toJSON(): {
        artifacts: SlytherArtifact[];
        closureHashes: Record<string, string>;
        scopeHashes: Record<string, string>;
        lang?: string;
        packages: Record<string, string>;
        roles: Record<string, SlytherRole["binding"]>;
    } {
        return {
            artifacts: this.artifacts,
            closureHashes: Object.fromEntries(this.closureHashes),
            scopeHashes: Object.fromEntries(this.scopeHashes),
            lang: this.lang,
            packages: Object.fromEntries(this.packages),
            roles: Object.fromEntries(this.roles),
        };
    }
}
