---
name: delete-type
description: Deletes a type artifact by id from src/types, then finds, prints, and removes all dangling references to it in the codebase.
---

# delete type

Every step below is either **deterministic** (run the script exactly as written, from the project root,
and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.
Follow the steps in order.

## Rules

ID: name

1. ALL Types are defined at src/types/{name}.type.ts, where name is the id written in PascalCase.
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

2. **deterministic** — Run .gstudio/artifacts/type/scripts/delete/step-2.ts <id> to delete the type identified by `id`.

3. **deterministic** — Run .gstudio/artifacts/type/scripts/delete/step-3.sh <id>, passing the same type id used for the delete action, to print every existing reference to that type as `[file path]:[line number]` lines.

4. **llm** — Remove all the dangling references to the type, run the previous command to ensure all the references are gone. If not, fix it and run the command again.
