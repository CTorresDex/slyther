import * as fs from "node:fs";
import * as path from "node:path";

function toCamelCase(input: string): string {
  return input
    .replace(/[_-]+(.)/g, (_, chr: string) => chr.toUpperCase())
    .replace(/^[A-Z]/, (chr) => chr.toLowerCase());
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

  const name = toCamelCase(id);
  const filePath = path.join("src", "src", "singletons", `${name}.singleton.ts`);

  if (!fs.existsSync(filePath)) {
    console.log(`MISSING_FILE: Expected singleton file not found at ${filePath}.`);
    process.exit(1);
  }

  const source = fs.readFileSync(filePath, "utf-8");
  const sanitized = stripCommentsAndStrings(source);
  const segments = splitTopLevelSegments(sanitized);

  const errors: string[] = [];

  const importRegex = /^import\b/;
  const reexportRegex = /^export\s*(\*|\{)/;
  const exportedConstRegex = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[\s\S]*?)?=/;
  const strictSingletonRegex = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=/;
  const helperRegex =
    /^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function|let|var|class|interface|type|enum|namespace|module)\b/;
  const nonExportedConstRegex = /^const\b/;

  type Kind = "import" | "const" | "helper" | "other";
  const classified: { seg: string; kind: Kind }[] = segments.map((seg) => {
    if (importRegex.test(seg) || reexportRegex.test(seg)) {
      return { seg, kind: "import" as Kind };
    }
    if (exportedConstRegex.test(seg)) {
      return { seg, kind: "const" as Kind };
    }
    if (helperRegex.test(seg) || nonExportedConstRegex.test(seg)) {
      return { seg, kind: "helper" as Kind };
    }
    return { seg, kind: "other" as Kind };
  });

  const constSegments = classified.filter((c) => c.kind === "const");

  if (constSegments.length === 0) {
    errors.push(
      `NO_SINGLETON_FOUND: No singleton declaration found in ${filePath}; expected 'export const ${name} = ...'.`
    );
  } else if (constSegments.length > 1) {
    errors.push(
      `MULTIPLE_SINGLETONS: Found ${constSegments.length} top-level singleton declarations in ${filePath}; only one singleton definition is allowed.`
    );
  } else {
    const seg = constSegments[0].seg;
    const strictMatch = seg.match(strictSingletonRegex);
    if (!strictMatch) {
      errors.push(
        `SINGLETON_SHAPE_INVALID: Singleton declaration in ${filePath} does not match the required shape 'export const ${name} = ...': found '${snippet(seg)}'.`
      );
    } else if (strictMatch[1] !== name) {
      errors.push(
        `SINGLETON_NAME_MISMATCH: Singleton in ${filePath} is named '${strictMatch[1]}' but expected '${name}' (camelCase of id '${id}').`
      );
    }
  }

  for (const { seg, kind } of classified) {
    if (kind === "helper" || kind === "other") {
      errors.push(
        `TOP_LEVEL_DECLARATION: Disallowed top-level ${kind === "helper" ? "declaration" : "statement"} found in ${filePath}: '${snippet(seg)}'. Only imports and the singleton definition are allowed at the top level.`
      );
    }
  }

  if (constSegments.length === 1) {
    const constIndex = classified.indexOf(constSegments[0]);
    for (let i = constIndex + 1; i < classified.length; i++) {
      errors.push(
        `SHAPE_VIOLATION: Found content after the singleton declaration in ${filePath}: '${snippet(classified[i].seg)}'. The singleton must be the last top-level definition in the file.`
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
