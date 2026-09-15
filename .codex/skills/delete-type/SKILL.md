---
name: delete-type
description: Deletes a type artifact by id, removing its file and cleaning up dangling references to it across the codebase.
---

# delete type

Every step below is either **deterministic** (run the script exactly as written, from the project root,
and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.
Follow the steps in order.

## Rules

ID: name

1. ALL Types are defined at src/src/types/{name}.type.ts, where name is the id written in PascalCase.
2. Every type must have only one top level definition, the type. No helper functions, no classes, no variables on the top level.
3. The type must strictly follow this shape:
```ts
// Imports

export type {name (PascalCase)} = {
    // type definition
}
```

## Steps

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/type/scripts/delete/step-2.ts <id> where <id> is the type's identifier (e.g. `.gstudio/artifacts/type/scripts/delete/step-2.ts myType`).

3. **deterministic** — Run .gstudio/artifacts/type/scripts/delete/step-3.sh <id> to print every existing reference to the type's PascalCase name in the codebase, each on its own `[file path]:[line number]` line.

4. **llm** — Remove all the dangling references to the type, run the previous command to ensure all the references are gone. If not, fix it and run the command again.
