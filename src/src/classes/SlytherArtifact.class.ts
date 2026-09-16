// Imports
import { createHash } from "node:crypto";

export class SlytherArtifact {
    readonly hash: string;

    constructor(
        readonly artifact: string,
        readonly name: string,
        readonly args: {
            name: string;
            kind: "string" | "number" | "boolean" | "type";
            value: string | number | boolean;
            /** Only a type may be optional, written as `type?`. */
            optional?: boolean;
        }[],
        readonly qualifiers: string[],
        readonly content: string,
        readonly references: string[],
    ) {
        this.hash = createHash("sha256")
            .update(
                [
                    artifact,
                    name,
                    args
                        .map((arg) => `${arg.name}=${arg.kind}:${String(arg.value)}${arg.optional ? "?" : ""}`)
                        .join(","),
                    qualifiers.join(","),
                    content,
                ].join("\n"),
            )
            .digest("hex");
    }
}
