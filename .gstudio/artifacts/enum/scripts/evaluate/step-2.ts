import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

function toPascalCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

function main(): void {
  const id = process.argv[2];

  if (!id) {
    console.log('INVALID_INPUT: Missing required argument <id>.');
    process.exit(1);
  }

  const pascalName = toPascalCase(id);
  const relativePath = path.join('src', 'enums', `${pascalName}.enum.ts`);
  const absolutePath = path.resolve(process.cwd(), relativePath);

  if (!fs.existsSync(absolutePath)) {
    console.log(`ENUM_FILE_NOT_FOUND: Expected enum file at ${relativePath}.`);
    process.exit(1);
  }

  const sourceText = fs.readFileSync(absolutePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    absolutePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const errors: string[] = [];

  const topLevelStatements = sourceFile.statements.filter(
    (statement) => !ts.isImportDeclaration(statement) && !ts.isImportEqualsDeclaration(statement)
  );

  const enumDeclarations = topLevelStatements.filter(ts.isEnumDeclaration);
  const otherDeclarations = topLevelStatements.filter((statement) => !ts.isEnumDeclaration(statement));

  if (enumDeclarations.length === 0) {
    errors.push(`ENUM_NOT_FOUND: No enum declaration found in ${relativePath}.`);
  }

  if (enumDeclarations.length > 1) {
    errors.push(
      `ENUM_MULTIPLE_DECLARATIONS: Found ${enumDeclarations.length} enum declarations in ${relativePath}, expected exactly one.`
    );
  }

  for (const statement of otherDeclarations) {
    const kindName = ts.SyntaxKind[statement.kind];
    errors.push(
      `ENUM_EXTRA_TOP_LEVEL_DEFINITION: Found disallowed top-level ${kindName} in ${relativePath}, only the enum definition is allowed.`
    );
  }

  if (enumDeclarations.length === 1) {
    const enumDeclaration = enumDeclarations[0];
    const modifiers = enumDeclaration.modifiers ?? [];
    const isExported = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    const isConst = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ConstKeyword);
    const isDeclared = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);

    if (!isExported || isDefault) {
      errors.push(
        `ENUM_NOT_EXPORTED: The enum in ${relativePath} must be declared as "export enum ${pascalName} { ... }".`
      );
    }

    if (isConst) {
      errors.push(`ENUM_IS_CONST: The enum in ${relativePath} must not be declared as a const enum.`);
    }

    if (isDeclared) {
      errors.push(`ENUM_IS_AMBIENT: The enum in ${relativePath} must not be declared as an ambient (declare) enum.`);
    }

    if (enumDeclaration.name.text !== pascalName) {
      errors.push(
        `ENUM_NAME_MISMATCH: The enum in ${relativePath} is named "${enumDeclaration.name.text}", expected "${pascalName}".`
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
