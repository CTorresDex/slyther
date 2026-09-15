// Imports
import { createHash } from "node:crypto";

export class SlytherArtifact {
    readonly hash: string;

    constructor(
        readonly artifact: string,
        readonly name: string,
        readonly content: string,
        readonly references: string[],
    ) {
        this.hash = createHash("sha256")
            .update([artifact, name, content, references.join(",")].join("\n"))
            .digest("hex");
    }
}
