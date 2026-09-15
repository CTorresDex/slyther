---
name: delete-enum
description: Deletes the enum artifact with the given id from src/src/enums, removing its file and cleaning up dangling references to it across the codebase.
---

# delete enum

Every step below is either **deterministic** (run the script exactly as written, from the project root,
and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.
Follow the steps in order.

## Rules

ID: name

1. ALL Enums are defined at src/src/enums/{name}.enum.ts, where name is the id written in PascalCase.
2. Every enum must have only one top level definition, the enum. No helper functions, no types, no variables on the top level.
3. The enum must strictly follow this shape:
```ts
export enum {name (PascalCase)} {
    // enum members
}
```

## Steps

1. **llm** — Input: {id}

2. **deterministic** — Run `.gstudio/artifacts/enum/scripts/delete/step-2.ts <id>` where `<id>` is the enum's id, to delete the corresponding enum file if it exists.

3. **deterministic** — Run .gstudio/artifacts/enum/scripts/delete/step-3.sh <id> where <id> is the enum's identifier, to print every "file path:line number" reference to that enum found in the codebase.

4. **llm** — Remove all the dangling references to the enum, run the previous command to ensure all the references are gone. If not, fix it and run the command again.
