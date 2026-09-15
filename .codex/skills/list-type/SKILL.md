---
name: list-type
description: Lists type artifacts in the codebase matching an optional search term, printing each result's id and file path.
---

# list type

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

1. **llm** — Input (Optional): search term

2. **deterministic** — Run .gstudio/artifacts/type/scripts/list/step-2.ts [searchTerm] from the project root, where `searchTerm` is an optional string to filter types by content.

3. **llm** — Report the results of the previous command.
