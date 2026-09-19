import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlytherLanguageService } from "../src/classes/SlytherLanguageService.class.ts";

describe("SlytherLanguageService", () => {
    let folder: string;
    let main: string;
    let other: string;
    let open: Map<string, string>;
    let service: SlytherLanguageService;

    beforeEach(async () => {
        folder = await mkdtemp(join(tmpdir(), "slyther-lsp-"));
        main = join(folder, "main.sly");
        other = join(folder, "other.sly");
        open = new Map();
        service = new SlytherLanguageService({ get: (path) => open.get(path) });

        await writeFile(main, ['@lang "ts"', '@import "./other.sly"', "@use App", "", "class Users {", "  Keeps every user, see #{Store}", "}", "method Users::save { writes #{Users} }", "class Store (kind: Users) { x }"].join("\n"));
        await writeFile(other, ["@artifact class {", "  operation locate (id: string): deterministic { find it }", "  operation list {", "    deterministic go { x }", "  }", "}", "@artifact method"].join("\n"));
    });

    afterEach(async () => {
        await rm(folder, { recursive: true, force: true });
    });

    test("finds the project of a file by the entry point that reaches it", () => {
        const symbols = service.symbols(other);

        expect(symbols.map((symbol) => `${symbol.artifact} ${symbol.name} [${symbol.children.map((child) => child.name).join(", ")}]`)).toEqual([
            "artifact class [locate, list]",
            "artifact method []",
        ]);
        expect(service.symbols(main).map((symbol) => `${symbol.name} [${symbol.children.map((child) => child.name).join(", ")}]`)).toEqual(["App::Users [save]", "App::Store []"]);
    });

    test("a file no entry point reaches is a project of its own", () => {
        const alone = join(folder, "alone.sly");

        open.set(alone, "@artifact thing\nthing One { sees #{Two} }\nthing Two { x }");

        expect(service.diagnostics(alone)).toEqual([]);
        expect(service.symbols(alone).map((symbol) => symbol.name)).toEqual(["thing", "One", "Two"]);
    });

    test("goes from a reference, a type, a kind and a path to the declaration", () => {
        expect(service.definition(main, 5, 28)).toEqual([{ file: main, line: 8, start: 6, end: 11 }]);
        expect(service.definition(main, 8, 20)).toEqual([{ file: main, line: 4, start: 6, end: 11 }]);
        expect(service.definition(main, 4, 2)).toEqual([{ file: other, line: 0, start: 10, end: 15 }]);
        expect(service.definition(main, 1, 12)).toEqual([{ file: other, line: 0, start: 0, end: 0 }]);
        expect(service.definition(main, 3, 0)).toEqual([]);
    });

    test("finds every reference to a declaration across the project", () => {
        expect(service.references(main, 4, 8, true)).toEqual([
            { file: main, line: 4, start: 6, end: 11 },
            { file: main, line: 7, start: 30, end: 35 },
            { file: main, line: 8, start: 19, end: 24 },
        ]);
        expect(service.references(other, 0, 12, false).map((location) => `${location.line}:${location.start}`)).toEqual(["4:0", "8:0"]);
    });

    test("describes what is hovered", () => {
        expect(service.hover(main, 8, 8)).toEqual({ markdown: "```slyther\nclass App::Store (kind: Users)\n```\n\nx", start: 6, end: 11 });
        expect(service.hover(other, 1, 14)?.markdown).toBe("```slyther\noperation class::locate (id: string) : deterministic\n```\n\nfind it");
        expect(service.hover(main, 1, 12)).toEqual({ markdown: `\`${other}\``, start: 9, end: 20 });
        expect(service.hover(main, 5, 3)).toBeUndefined();
    });

    test("completes references from the scope, kinds where they may open, qualifiers, types and namespaces", () => {
        expect(service.completions(main, 5, "  see #{St").map((item) => `${item.label}:${item.start}-${item.end}`)).toEqual([
            "App:8-10",
            "App::Store:8-10",
            "App::Users:8-10",
            "App::Users::save:8-10",
            "class:8-10",
            "class::list:8-10",
            "class::list::go:8-10",
            "class::locate:8-10",
            "method:8-10",
            "Store:8-10",
            "Users:8-10",
            "Users::save:8-10",
        ]);
        expect(service.completions(main, 10, "cl").map((item) => item.label)).toEqual(["class", "method", "@artifact", "@import", "@use", "@lang", "@run"]);
        expect(service.completions(other, 1, "  op").map((item) => item.label)).toEqual(["operation"]);
        expect(service.completions(other, 3, "    ").map((item) => item.label)).toEqual(["llm", "deterministic"]);
        expect(service.completions(main, 10, "class X (a: string): d").map((item) => item.label)).toEqual(["deterministic"]);
        expect(service.completions(main, 10, "class X (a: ").slice(0, 4).map((item) => item.label)).toEqual(["string", "number", "boolean", "App"]);
        expect(service.completions(main, 10, "@use A").map((item) => item.label)).toEqual(["App"]);
        expect(service.completions(main, 5, "  prose here")).toEqual([]);
    });

    test("folds every block that spans lines", () => {
        expect(service.folding(main)).toEqual([{ start: 4, end: 5 }]);
        expect(service.folding(other)).toEqual([{ start: 0, end: 4 }, { start: 2, end: 3 }]);
    });

    test("reports what is wrong in what the editor holds, and forgets it once told", () => {
        open.set(main, "@import \"./other.sly\"\nclass Users { sees #{Nobody} }");
        service.invalidate();

        expect(service.diagnostics(main)).toEqual([{ file: main, line: 1, start: 21, end: 27, message: 'Unknown reference "Nobody".', severity: "error" }]);
        expect(service.diagnostics(other)).toEqual([]);

        open.delete(main);
        service.invalidate();

        expect(service.diagnostics(main)).toEqual([]);
    });

    test("reports what the grouping of kinds finds on the declaration it names, once the project parses", () => {
        expect(service.diagnostics(other)).toEqual([
            { file: other, line: 2, start: 12, end: 16, message: 'Operation "class::list" has only deterministic steps: qualify it as deterministic.', severity: "warning" },
        ]);

        open.set(other, "@artifact class {\n  operation create (id: string) { make }\n}\n@artifact method");
        service.invalidate();

        expect(service.diagnostics(other).map((diagnostic) => `${diagnostic.severity} ${diagnostic.line}:${diagnostic.start}-${diagnostic.end}`)).toEqual(["error 0:10-15"]);
    });

    test("finds declarations across the project by name", () => {
        expect(service.workspaceSymbols(main, "sto").map((symbol) => `${symbol.name}@${symbol.file === main ? "main" : "other"}:${symbol.line}`)).toEqual(["App::Store@main:8"]);
        expect(service.workspaceSymbols(other, "LOC").map((symbol) => symbol.name)).toEqual(["class::locate"]);
    });
});
