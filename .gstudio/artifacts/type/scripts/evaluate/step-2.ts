The file wasn't written since permission wasn't granted. Per the task's output format, I'll provide the script as raw text directly instead.

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

function toPascalCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

function main(): void {
  const id = process.argv[2];

  if (!id) {
    console.log("INVALID_INPUT: Missing required argument <id>.");
    process.exit(1);
  }

  const typeName = toPascalCase(id);
  const relativePath = path.join("src", "src", "types", `${typeName}.type.ts`);
  const absolutePath = path.resolve(process.cwd(), relativePath);

  const errors: string[] = [];

  if (!fs.existsSync(absolutePath)) {
    console.log(`MISSING_FILE: Expected type file not found at ${relativePath}.`);
    process.exit(1);
  }

  const sourceText = fs.readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(
    absolutePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const topLevelStatements = sourceFile.statements.filter(
    (statement) => !ts.isImportDeclaration(statement) && !ts.isImportEqualsDeclaration(statement)
  );

  const typeDeclarations = topLevelStatements.filter(ts.isTypeAliasDeclaration);
  const otherDeclarations = topLevelStatements.filter((statement) => !ts.isTypeAliasDeclaration(statement));

  if (typeDeclarations.length === 0) {
    errors.push(
      `TYPE_NOT_FOUND: No type declaration found in ${relativePath}; expected 'export type ${typeName} = { ... }'.`
    );
  }

  if (typeDeclarations.length > 1) {
    errors.push(
      `TYPE_MULTIPLE_DECLARATIONS: Found ${typeDeclarations.length} top-level type declarations in ${relativePath}, expected exactly one.`
    );
  }

  for (const statement of otherDeclarations) {
    const kindName = ts.SyntaxKind[statement.kind];
    errors.push(
      `TYPE_EXTRA_TOP_LEVEL_DEFINITION: Found disallowed top-level ${kindName} in ${relativePath}, only the type definition is allowed.`
    );
  }

  if (typeDeclarations.length === 1) {
    const typeDeclaration = typeDeclarations[0];
    const modifiers = typeDeclaration.modifiers ?? [];
    const isExported = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    const isDeclared = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);

    if (!isExported || isDefault) {
      errors.push(
        `TYPE_NOT_EXPORTED: The type in ${relativePath} must be declared as "export type ${typeName} = { ... }".`
      );
    }

    if (isDeclared) {
      errors.push(`TYPE_IS_AMBIENT: The type in ${relativePath} must not be declared as an ambient (declare) type.`);
    }

    if (typeDeclaration.name.text !== typeName) {
      errors.push(
        `TYPE_NAME_MISMATCH: The type in ${relativePath} is named "${typeDeclaration.name.text}", expected "${typeName}".`
      );
    }

    if (typeDeclaration.typeParameters && typeDeclaration.typeParameters.length > 0) {
      errors.push(`TYPE_HAS_TYPE_PARAMETERS: The type in ${relativePath} must not declare generic type parameters.`);
    }

    if (!ts.isTypeLiteralNode(typeDeclaration.type)) {
      errors.push(
        `TYPE_SHAPE_INVALID: The type in ${relativePath} must be defined as an object shape: "export type ${typeName} = { ... }".`
      );
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.log(error);
    }
    process.exit(1);
  }

  process.exit(0);
}

main();
