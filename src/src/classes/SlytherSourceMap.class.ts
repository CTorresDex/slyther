// Imports

export class SlytherSourceMap {
    /** Every script read, as an absolute path, in the order read. A script parsed from a string with no path is "". */
    readonly files: string[] = [];
    /** Every declaration read, in the order read. A name declared twice is listed twice, so both are found. */
    readonly declarations: {
        /** The qualified name. */
        name: string;
        artifact: string;
        scope: string;
        file: string;
        /** The line it opens on and the last line its body takes, the same line when it has no body. */
        line: number;
        last: number;
        /** The columns of the kind, or the directive, on the opening line. */
        kind: { start: number; end: number };
        /** The columns of the name on the opening line. */
        at: { start: number; end: number };
    }[] = [];
    /** Every name written that points at a declaration, in the order read. */
    readonly references: {
        file: string;
        line: number;
        start: number;
        end: number;
        /** The name as written. */
        name: string;
        /** The scope it resolves in. */
        scope: string;
        /** The qualified name of the declaration it is written in. */
        owner: string;
        /** `#{Name}` in prose, the type of an arg, or the kind that opens a declaration. */
        role: "reference" | "type" | "kind";
        /** The qualified name it resolves to once everything is declared, or undefined when it resolves to nothing. */
        target?: string;
    }[] = [];
    /** Every path written, with what it resolves to. */
    readonly paths: {
        file: string;
        line: number;
        start: number;
        end: number;
        directive: "import" | "from" | "ref";
        /** The absolute path it points at. */
        path: string;
    }[] = [];
    /** Everything found wrong, in the order found. */
    readonly diagnostics: {
        file: string;
        line: number;
        start: number;
        end: number;
        message: string;
        severity: "error" | "warning";
    }[] = [];

    /** The first declaration of the name, if any. */
    declarationOf(name: string): SlytherSourceMap["declarations"][number] | undefined {
        return this.declarations.find((declaration) => declaration.name === name);
    }

    /** The innermost declaration whose lines hold the given line of the file, if any; when strictly, one that opens on the line itself does not count. */
    enclosing(file: string, line: number, strictly = false): SlytherSourceMap["declarations"][number] | undefined {
        return this.declarations
            .filter((declaration) => declaration.file === file && (strictly ? declaration.line < line : declaration.line <= line) && line <= declaration.last)
            .sort((a, b) => b.line - a.line || a.last - b.last)[0];
    }

    /**
     * What is written under the given position: the name of a declaration, a reference or a path, or
     * nothing. A position right after the last character still counts as on it, as a cursor does.
     */
    at(
        file: string,
        line: number,
        character: number,
    ):
        | { kind: "declaration"; declaration: SlytherSourceMap["declarations"][number] }
        | { kind: "reference"; reference: SlytherSourceMap["references"][number] }
        | { kind: "path"; path: SlytherSourceMap["paths"][number] }
        | undefined {
        const within = (span: { file: string; line: number; start: number; end: number }) =>
            span.file === file && span.line === line && span.start <= character && character <= span.end;
        const declaration = this.declarations.find((candidate) => within({ file: candidate.file, line: candidate.line, ...candidate.at }));

        if (declaration) {
            return { kind: "declaration", declaration };
        }

        const reference = this.references.find(within);

        if (reference) {
            return { kind: "reference", reference };
        }

        const path = this.paths.find(within);

        return path ? { kind: "path", path } : undefined;
    }
}
