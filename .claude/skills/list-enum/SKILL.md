---
name: list-enum
description: "Lists enums under src/enums matching an optional search term and prints each as id: file path."
---

# list enum

Every step below is either **deterministic** (run the script exactly as written, from the project root,
and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.
Follow the steps in order.

## Rules

ID: name

1. ALL Enums are defined at src/enums/{name}.enum.ts, where name is the id written in PascalCase.
2. Every enum must have only one top level definition, the enum. No helper functions, no types, no variables on the top level.
3. The enum must strictly follow this shape:
```ts
export enum {name (PascalCase)} {
    // enum members
}
```

## Steps

1. **llm** — Input (Optional): search term

2. **deterministic** — Run .gstudio/artifacts/enum/scripts/list/step-2.ts [searchTerm] to list all enums under src/enums, optionally filtered to those whose file contents include the given search term.

3. **llm** — Report the results of the previous command.
