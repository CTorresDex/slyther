---
name: evaluate-enum
description: Checks that an enum artifact's file location, single top-level definition, and required shape comply with the enum rules, given an enum id.
---

# evaluate enum

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

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/enum/scripts/evaluate/step-2.ts <id> where <id> is the enum's id (it will be converted to PascalCase to resolve the enum file).

3. **llm** — 1. The members of the enum belong to a single closed set of values, any value that is not part of that set must be defined at its own enum.
