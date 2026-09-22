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
                "how code outside reaches the member and the shape is its type or signature, without bodies, private",
                "members or comments. The key of what the artifact exports at the top level is its name, and the key",
                "of a public member of an exported class or object is `Owner.member`, so a class prints one line for",
                "itself and one per public member, like `StringUtils class` and `StringUtils.capitalize (value: string): string` for a",
                "class with a single static method.",
                "Anything whose addition breaks the artifacts that use this one, like a required constructor param,",
                "is printed as a change of an existing line and never as a new line.",
                "The artifact is every segment locate prints, one per line, so its output is read line by line",
                "and never taken as a single path.",
                "Prints nothing and exits 1 when the artifact does not exist, and exits 0 whenever it does.",
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
                "Every key is written as the signature of that artifact prints it: the name of what it imports, and",
                "`Owner.member` for every member it reaches through it, so code that imports StringUtils and calls",
                "`StringUtils.capitalize` prints `kind:id StringUtils` and `kind:id StringUtils.capitalize`, never",
                "the owner alone. It never prints the artifact itself, whatever it reaches of its own.",
                "The artifact is every segment locate prints, one per line, so its output is read line by line",
                "and never taken as a single path.",
                "Prints nothing and exits 1 when the artifact does not exist, and exits 0 whenever it does.",
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
