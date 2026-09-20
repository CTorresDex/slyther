// Imports
import { SlytherArtifact } from "./SlytherArtifact.class.ts";

export class SlytherBuiltinOperation {
    /**
     * The operations a kind with operations has without declaring them, in the order they are added. One
     * marked as referenced is only added when an instance of the kind is referenced by another artifact,
     * since it only serves to decide whether what references it must be evaluated again.
     */
    private static readonly ALL: { name: string; params: string[]; content: string; referenced: boolean }[] = [
        {
            name: "list",
            referenced: false,
            params: [],
            content: "Prints the id of every artifact of the kind that exists, one per line, and exits 0.",
        },
        {
            name: "signature",
            referenced: true,
            params: ["id"],
            content: [
                "Prints the public shape of the artifact, one member per line as `key shape`, where the key is",
                "the stable name of the member and the shape is its type or signature, without bodies, private",
                "members or comments. Anything whose addition breaks the artifacts that use this one, like a",
                "required constructor param, is printed as a change of an existing line and never as a new line.",
                "Prints nothing and exits 1 when the artifact does not exist.",
            ].join("\n"),
        },
        {
            name: "uses",
            referenced: true,
            params: ["id"],
            content: [
                "Prints one line per artifact this one depends on, as `kind:id key` for every member of it this",
                "artifact uses, as `kind:id *` when it uses it as a whole but does not depend on the members it",
                "may gain, and as `kind:id **` when it depends on every member, including the ones it may gain.",
                "Prints nothing and exits 1 when the artifact does not exist.",
            ].join("\n"),
        },
    ];

    /** The names of the built-in operations. */
    static get names(): string[] {
        return SlytherBuiltinOperation.ALL.map((operation) => operation.name);
    }

    /**
     * The built-in operations of the given kind, as artifacts named `Kind::name`: all of them when the
     * kind is referenced, else only the ones every kind has. Each narrows to the params it needs, as any
     * operation does, so a kind never hands one what its own instances declare.
     */
    static of(kind: string, referenced: boolean): SlytherArtifact[] {
        return SlytherBuiltinOperation.ALL.filter((operation) => referenced || !operation.referenced).map(
            (operation) =>
                new SlytherArtifact(
                    "operation",
                    `${kind}::${operation.name}`,
                    operation.params.map((param) => ({ name: param, kind: "param" as const, value: "" })),
                    ["deterministic"],
                    operation.content,
                    [],
                ),
        );
    }
}
