import * as fs from "node:fs";
import * as path from "node:path";

function toPascalCase(input: string): string {
    return input
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join("");
}

function stripCommentsAndStrings(source: string): string {
    let out = "";
    let i = 0;
    const n = source.length;

    while (i < n) {
        const c = source[i];
        const c2 = i + 1 < n ? source[i + 1] : "";

        if (c === "/" && c2 === "/") {
            i += 2;
            while (i < n && source[i] !== "\n") i++;
            continue;
        }

        if (c === "/" && c2 === "*") {
            i += 2;
            while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
            i += 2;
            continue;
        }

        if (c === "'" || c === '"' || c === "`") {
            const quote = c;
            i++;
            while (i < n && source[i] !== quote) {
                if (source[i] === "\\") i++;
                i++;
            }
            i++;
            out += quote + quote;
            continue;
        }

        out += c;
        i++;
    }

    return out;
}

function splitTopLevelSegments(sanitized: string): string[] {
    const segments: string[] = [];
    let depth = 0;
    let segStart = 0;
    let blockJustClosed = false;
    const n = sanitized.length;

    const isNonTerminalBrace = (segSoFar: string): boolean => {
        const trimmed = segSoFar.trimStart();
        return /^import\b/.test(trimmed) || /^export\s*(\*|\{)/.test(trimmed);
    };

    for (let i = 0; i < n; i++) {
        const ch = sanitized[i];

        if (ch === "{" || ch === "(" || ch === "[") {
            depth++;
            blockJustClosed = false;
            continue;
        }

        if (ch === "}" || ch === ")" || ch === "]") {
            depth--;
            if (depth === 0) {
                blockJustClosed = true;
            }
            continue;
        }

        if (ch === ";" && depth === 0) {
            const seg = sanitized.slice(segStart, i + 1);
            if (seg.trim().length > 0) segments.push(seg);
            segStart = i + 1;
            blockJustClosed = false;
            continue;
        }

        if (depth === 0 && blockJustClosed && !/\s/.test(ch)) {
            const soFar = sanitized.slice(segStart, i);
            if (!isNonTerminalBrace(soFar)) {
                const seg = soFar;
                if (seg.trim().length > 0) segments.push(seg);
                segStart = i;
            }
            blockJustClosed = false;
        }
    }

    const rest = sanitized.slice(segStart);
    if (rest.trim().length > 0) segments.push(rest);

    return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

function snippet(segment: string): string {
    const oneLine = segment.replace(/\s+/g, " ").trim();
    return oneLine.length > 60 ? `${oneLine.slice(0, 60)}...` : oneLine;
}

function main(): void {
    const id = process.argv[2];

    if (!id) {
        console.log("INVALID_INPUT: Missing required argument <id>.");
        process.exit(1);
    }

    const name = toPascalCase(id);

    if (!name) {
        console.log(`INVALID_INPUT: Could not derive a valid PascalCase name from "${id}".`);
        process.exit(1);
    }

    const filePath = path.join("src", "src", "enums", `${name}.enum.ts`);

    if (!fs.existsSync(filePath)) {
        console.log(`FILE_NOT_FOUND: Expected enum file not found at ${filePath}.`);
        process.exit(1);
    }

    const source = fs.readFileSync(filePath, "utf-8");
    const sanitized = stripCommentsAndStrings(source);
    const segments = splitTopLevelSegments(sanitized);

    const errors: string[] = [];

    const importRegex = /^import\b/;
    const reexportRegex = /^export\s*(\*|\{)/;
    const enumRegex = /^(export\s+)?(declare\s+)?(const\s+)?enum\b/;
    const strictEnumRegex = /^export\s+enum\s+([A-Za-z_$][\w$]*)\s*\{/;
    const helperRegex =
        /^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function|const|let|var|class|interface|type|namespace|module)\b/;

    type Kind = "import" | "enum" | "helper" | "other";
    const classified: { seg: string; kind: Kind }[] = segments.map((seg) => {
        if (importRegex.test(seg) || reexportRegex.test(seg)) {
            return { seg, kind: "import" as Kind };
        }
        if (enumRegex.test(seg)) {
            return { seg, kind: "enum" as Kind };
        }
        if (helperRegex.test(seg)) {
            return { seg, kind: "helper" as Kind };
        }
        return { seg, kind: "other" as Kind };
    });

    const enumSegments = classified.filter((c) => c.kind === "enum");

    if (enumSegments.length === 0) {
        errors.push(
            `NO_ENUM_FOUND: No enum declaration found in ${filePath}; expected 'export enum ${name} { ... }'.`
        );
    } else if (enumSegments.length > 1) {
        errors.push(
            `MULTIPLE_ENUMS: Found ${enumSegments.length} top-level enum declarations in ${filePath}; only one enum definition is allowed.`
        );
    } else {
        const seg = enumSegments[0].seg;
        const strictMatch = seg.match(strictEnumRegex);
        if (!strictMatch) {
            errors.push(
                `ENUM_SHAPE_INVALID: Enum declaration in ${filePath} does not match the required shape 'export enum ${name} { ... }': found '${snippet(seg)}'.`
            );
        } else if (strictMatch[1] !== name) {
            errors.push(
                `ENUM_NAME_MISMATCH: Enum in ${filePath} is named '${strictMatch[1]}' but expected '${name}' (PascalCase of id '${id}').`
            );
        }
    }

    for (const { seg, kind } of classified) {
        if (kind === "helper" || kind === "other") {
            errors.push(
                `TOP_LEVEL_DECLARATION: Disallowed top-level ${kind === "helper" ? "declaration" : "statement"} found in ${filePath}: '${snippet(seg)}'. Only imports and the enum definition are allowed at the top level.`
            );
        }
    }

    if (enumSegments.length === 1) {
        const enumIndex = classified.indexOf(enumSegments[0]);
        for (let i = enumIndex + 1; i < classified.length; i++) {
            errors.push(
                `SHAPE_VIOLATION: Found content after the enum declaration in ${filePath}: '${snippet(classified[i].seg)}'. The enum must be the last top-level definition in the file.`
            );
        }
    }

    if (errors.length > 0) {
        for (const err of errors) {
            console.log(err);
        }
        process.exit(1);
    }

    process.exit(0);
}

main();
