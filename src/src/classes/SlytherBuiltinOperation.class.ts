// Imports
import { SlytherArtifact } from "./SlytherArtifact.class.ts";

export class SlytherBuiltinOperation {
    /** The operations every kind with operations has, in the order they are added. */
    private static readonly ALL: { name: string; params: { name: string; type: string }[]; content: string }[] = [
        {
            name: "list",
            params: [],
            content: "Prints the id of every artifact of the kind that exists, one per line, and exits 0.",
        },
        {
            name: "signature",
            params: [{ name: "id", type: "string" }],
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
            params: [{ name: "id", type: "string" }],
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

    /** The built-in operations of the given kind, as artifacts named `Kind::name`. */
    static of(kind: string): SlytherArtifact[] {
        return SlytherBuiltinOperation.ALL.map(
            (operation) =>
                new SlytherArtifact(
                    "operation",
                    `${kind}::${operation.name}`,
                    operation.params.map((param) => ({ name: param.name, kind: "type", value: param.type })),
                    ["deterministic"],
                    operation.content,
                    [],
                ),
        );
    }
}
