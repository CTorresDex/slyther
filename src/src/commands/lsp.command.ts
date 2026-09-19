import { SlytherLanguageServer } from '../classes/SlytherLanguageServer.class.ts'

export const help = {
    short: 'Serve the language server protocol for Slyther scripts over stdio',
    long: `Usage: slyther lsp [--stdio]

Starts a language server for .sly files that talks the language server protocol over stdin and stdout,
for an editor to spawn. It parses the project of every open file, the nearest main.sly whose imports
reach it, or the file on its own, and reports what is wrong where it is written, without stopping at
the first problem. It answers with the outline of a file, where its blocks fold, where a #{Reference},
the type of an arg, the kind of a declaration or a path is declared, everywhere a declaration is
referenced, what a name is when hovered, and what may be written next: references, kinds, qualifiers,
types, namespaces and directives.

Flags:
  --stdio    accepted for editors that pass it; stdio is the only transport`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    new SlytherLanguageServer().listen()
}
