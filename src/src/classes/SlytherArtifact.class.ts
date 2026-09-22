// Imports
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { SlytherFolderSource } from "./SlytherFolderSource.class.ts";
import { SlytherRole } from "./SlytherRole.class.ts";

export class SlytherArtifact {
    readonly hash: string;

    constructor(
        readonly artifact: string,
        readonly name: string,
        readonly args: {
            name: string;
            /** A param is a bare name: an operation narrowing to a param its kind declares, with no value of its own. */
            kind: "string" | "number" | "boolean" | "type" | "param";
            value: string | number | boolean;
            /** Only a type may be optional, written as `type?`. */
            optional?: boolean;
        }[],
        readonly qualifiers: string[],
        readonly content: string,
        readonly references: string[],
        /**
         * The file the prose was written in instead of a body: `from` embeds it as the content, `ref` leaves the
         * content empty and only points at it. The path is relative to the folder everything runs from, and the
         * hash is the hash of what the file held when it was parsed.
         */
        readonly source?: { mode: "from" | "ref"; path: string; hash: string },
    ) {
        this.hash = createHash("sha256")
            .update(
                [
                    artifact,
                    name,
                    // Who does the work is not what the work is: a role only reaches a hash where it judges, through what evaluates.
                    args
                        .filter((arg) => !(arg.kind === "string" && arg.name === SlytherRole.BY))
                        .map((arg) => `${arg.name}=${arg.kind}:${String(arg.value)}${arg.optional ? "?" : ""}`)
                        .join(","),
                    qualifiers.join(","),
                    content,
                    ...(source ? [`${source.mode} ${source.path} ${source.hash}`] : []),
                ].join("\n"),
            )
            .digest("hex");
    }

    /** Whether the source is a folder, which a path kept with a trailing separator says without reading the disk. */
    private get folder(): boolean {
        return this.source?.path.endsWith(sep) ?? false;
    }

    /** The prose as whoever runs from the folder the source path is relative to reads it: a pointer to the file or folder when it is a ref. */
    get prose(): string {
        if (this.source?.mode !== "ref") {
            return this.content;
        }

        return this.folder
            ? `Read the files in \`${this.source.path}\`: they hold the prose of ${this.artifact} ${this.name}.`
            : `Read \`${this.source.path}\`: it holds the prose of ${this.artifact} ${this.name}.`;
    }

    /** The prose with a ref read into it, for whoever cannot read files, given the folder the source path is relative to. */
    textIn(cwd: string): string {
        if (this.source?.mode !== "ref") {
            return this.content;
        }

        return this.folder ? SlytherFolderSource.text(join(cwd, this.source.path)) : readFileSync(join(cwd, this.source.path), "utf-8").trim();
    }

    /** The artifact as the given kind and name, with the same prose, references and source. */
    as(artifact: string, name: string): SlytherArtifact {
        return new SlytherArtifact(artifact, name, [], [], this.content, this.references, this.source);
    }
}
