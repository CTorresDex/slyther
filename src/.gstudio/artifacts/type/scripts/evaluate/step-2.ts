import * as fs from "node:fs";
import * as path from "node:path";

function toPascalCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
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
    console.error("Usage: step-2.ts <id>");
    process.exit(1);
  }

  const typeName = toPascalCase(id);
  const filePath = path.join("src", "types", `${typeName}.type.ts`);

  if (!fs.existsSync(filePath)) {
    console.log(`MISSING_FILE: Expected type file not found at ${filePath}.`);
    process.exit(1);
  }

  const source = fs.readFileSync(filePath, "utf-8");
  const sanitized = stripCommentsAndStrings(source);
  const segments = splitTopLevelSegments(sanitized);

  const errors: string[] = [];

  const importRegex = /^import\b/;
  const reexportRegex = /^export\s*(\*|\{)/;
  const typeDeclRegex = /^(export\s+)?(declare\s+)?type\b/;
  const strictTypeRegex = /^export\s+type\s+([A-Za-z_$][\w$]*)\s*=\s*\{/;
  const helperRegex =
    /^(export\s+)?(declare\s+)?(default\s+)?(abstract\s+)?(async\s+)?(function|const|let|var|class|interface|enum|namespace|module)\b/;

  type Kind = "import" | "type" | "helper" | "other";
  const classified: { seg: string; kind: Kind }[] = segments.map((seg) => {
    if (importRegex.test(seg) || reexportRegex.test(seg)) {
      return { seg, kind: "import" as Kind };
    }
    if (typeDeclRegex.test(seg)) {
      return { seg, kind: "type" as Kind };
    }
    if (helperRegex.test(seg)) {
      return { seg, kind: "helper" as Kind };
    }
    return { seg, kind: "other" as Kind };
  });

  const typeSegments = classified.filter((c) => c.kind === "type");

  if (typeSegments.length === 0) {
    errors.push(
      `NO_TYPE_FOUND: No type declaration found in ${filePath}; expected 'export type ${typeName} = { ... }'.`
    );
  } else if (typeSegments.length > 1) {
    errors.push(
      `MULTIPLE_TYPES: Found ${typeSegments.length} top-level type declarations in ${filePath}; only one type definition is allowed.`
    );
  } else {
    const seg = typeSegments[0].seg;
    const strictMatch = seg.match(strictTypeRegex);
    if (!strictMatch) {
      errors.push(
        `TYPE_SHAPE_INVALID: Type declaration in ${filePath} does not match the required shape 'export type ${typeName} = { ... }': found '${snippet(seg)}'.`
      );
    } else if (strictMatch[1] !== typeName) {
      errors.push(
        `TYPE_NAME_MISMATCH: Type in ${filePath} is named '${strictMatch[1]}' but expected '${typeName}' (PascalCase of id '${id}').`
      );
    }
  }

  for (const { seg, kind } of classified) {
    if (kind === "helper" || kind === "other") {
      errors.push(
        `TOP_LEVEL_DECLARATION: Disallowed top-level ${kind === "helper" ? "declaration" : "statement"} found in ${filePath}: '${snippet(seg)}'. Only imports and the type definition are allowed at the top level.`
      );
    }
  }

  if (typeSegments.length === 1) {
    const typeIndex = classified.indexOf(typeSegments[0]);
    for (let i = typeIndex + 1; i < classified.length; i++) {
      errors.push(
        `SHAPE_VIOLATION: Found content after the type declaration in ${filePath}: '${snippet(classified[i].seg)}'. The type must be the last top-level definition in the file.`
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
