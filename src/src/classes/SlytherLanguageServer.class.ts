// Imports
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    CompletionItemKind,
    DiagnosticSeverity,
    SymbolKind,
    TextDocumentSyncKind,
    TextDocuments,
    createConnection,
    uinteger,
    type CompletionItem,
    type Connection,
    type Diagnostic,
    type DocumentSymbol,
    type Location,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { SlytherLanguageService } from "./SlytherLanguageService.class.ts";

export class SlytherLanguageServer {
    /** How long to wait after a change before reporting what is wrong, so typing is not raced. */
    private static readonly DEBOUNCE = 150;
    /** What a declaration of each kind is shown as in an outline; a kind absent here is an instance of a user kind. */
    private static readonly SYMBOLS: Record<string, SymbolKind> = {
        artifact: SymbolKind.Interface,
        namespace: SymbolKind.Namespace,
        operation: SymbolKind.Method,
        llm: SymbolKind.Function,
        deterministic: SymbolKind.Function,
        run: SymbolKind.Event,
    };
    /** What each completion is shown as. */
    private static readonly COMPLETIONS: Record<string, CompletionItemKind> = {
        reference: CompletionItemKind.Reference,
        kind: CompletionItemKind.Class,
        qualifier: CompletionItemKind.Keyword,
        type: CompletionItemKind.TypeParameter,
        namespace: CompletionItemKind.Module,
        directive: CompletionItemKind.Keyword,
    };

    private readonly connection: Connection;
    private readonly documents = new TextDocuments(TextDocument);
    /** The open documents by path, since the service knows paths and the editor knows uris. */
    private readonly open = new Map<string, TextDocument>();
    private readonly service = new SlytherLanguageService({ get: (path) => this.open.get(path)?.getText() });
    private pending: ReturnType<typeof setTimeout> | undefined;

    constructor(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
        this.connection = createConnection(input, output);

        this.connection.onInitialize(() => ({
            capabilities: {
                textDocumentSync: TextDocumentSyncKind.Incremental,
                completionProvider: { triggerCharacters: ["{", "@", ":", " "] },
                hoverProvider: true,
                definitionProvider: true,
                referencesProvider: true,
                documentSymbolProvider: true,
                workspaceSymbolProvider: true,
                foldingRangeProvider: true,
            },
        }));

        this.documents.onDidOpen(({ document }) => this.open.set(fileURLToPath(document.uri), document));
        this.documents.onDidChangeContent(({ document }) => {
            this.open.set(fileURLToPath(document.uri), document);
            this.service.invalidate();
            this.validateLater();
        });
        this.documents.onDidClose(({ document }) => {
            this.open.delete(fileURLToPath(document.uri));
            this.service.invalidate();
            this.connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
            this.validateLater();
        });

        this.connection.onCompletion(({ textDocument, position }) => {
            const document = this.documents.get(textDocument.uri);

            if (!document) {
                return [];
            }

            const text = document.getText({ start: { line: position.line, character: 0 }, end: position });

            return this.service.completions(fileURLToPath(textDocument.uri), position.line, text).map(
                (item): CompletionItem => ({
                    label: item.label,
                    detail: item.detail,
                    kind: SlytherLanguageServer.COMPLETIONS[item.kind],
                    filterText: item.label,
                    textEdit: { newText: item.label, range: { start: { line: position.line, character: item.start }, end: { line: position.line, character: item.end } } },
                }),
            );
        });

        this.connection.onHover(({ textDocument, position }) => {
            const hover = this.service.hover(fileURLToPath(textDocument.uri), position.line, position.character);

            return hover && { contents: { kind: "markdown", value: hover.markdown }, range: { start: { line: position.line, character: hover.start }, end: { line: position.line, character: hover.end } } };
        });

        this.connection.onDefinition(({ textDocument, position }) =>
            this.service.definition(fileURLToPath(textDocument.uri), position.line, position.character).map(SlytherLanguageServer.locationOf),
        );

        this.connection.onReferences(({ textDocument, position, context }) =>
            this.service.references(fileURLToPath(textDocument.uri), position.line, position.character, context.includeDeclaration).map(SlytherLanguageServer.locationOf),
        );

        this.connection.onDocumentSymbol(({ textDocument }) => this.service.symbols(fileURLToPath(textDocument.uri)).map(SlytherLanguageServer.symbolOf));

        this.connection.onWorkspaceSymbol(({ query }) => {
            const [file] = this.open.keys();

            if (file === undefined) {
                return [];
            }

            return this.service.workspaceSymbols(file, query).map((symbol) => ({
                name: symbol.name,
                kind: SlytherLanguageServer.SYMBOLS[symbol.artifact] ?? SymbolKind.Class,
                location: SlytherLanguageServer.locationOf({ file: symbol.file, line: symbol.line, ...symbol.at }),
            }));
        });

        this.connection.onFoldingRanges(({ textDocument }) => this.service.folding(fileURLToPath(textDocument.uri)).map((range) => ({ startLine: range.start, endLine: range.end })));
    }

    /** Starts serving. Stdout carries the protocol alone, so anything printed from here on goes to stderr. */
    listen(): void {
        console.log = (...data: unknown[]) => console.error(...data);
        this.documents.listen(this.connection);
        this.connection.listen();
    }

    /** Reports what is wrong in every open document once typing settles. */
    private validateLater(): void {
        clearTimeout(this.pending);
        this.pending = setTimeout(() => this.validate(), SlytherLanguageServer.DEBOUNCE);
    }

    private validate(): void {
        for (const [path, document] of this.open) {
            const diagnostics = this.service.diagnostics(path).map(
                (diagnostic): Diagnostic => ({
                    range: { start: { line: diagnostic.line, character: diagnostic.start }, end: { line: diagnostic.line, character: diagnostic.end } },
                    message: diagnostic.message,
                    severity: diagnostic.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
                    source: "slyther",
                }),
            );

            this.connection.sendDiagnostics({ uri: document.uri, diagnostics });
        }
    }

    private static locationOf(span: { file: string; line: number; start: number; end: number }): Location {
        return { uri: pathToFileURL(span.file).href, range: { start: { line: span.line, character: span.start }, end: { line: span.line, character: span.end } } };
    }

    private static symbolOf(symbol: SlytherLanguageService["symbol"]): DocumentSymbol {
        return {
            name: symbol.name,
            detail: symbol.artifact,
            kind: SlytherLanguageServer.SYMBOLS[symbol.artifact] ?? SymbolKind.Class,
            range: { start: { line: symbol.line, character: 0 }, end: { line: symbol.last, character: uinteger.MAX_VALUE } },
            selectionRange: { start: { line: symbol.line, character: symbol.at.start }, end: { line: symbol.line, character: symbol.at.end } },
            children: symbol.children.map(SlytherLanguageServer.symbolOf),
        };
    }
}
