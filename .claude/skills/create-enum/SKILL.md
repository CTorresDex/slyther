---
name: create-enum
description: Scaffolds a new enum file at src/enums/{Name}.enum.ts given an enum id and optional initial members, failing if the file already exists.
---

# create enum

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

1. **llm** — Input: {id} and optionally the members of the enum

2. **deterministic** — Run .gstudio/artifacts/enum/scripts/create/step-2.ts <id> with the enum's id as the first argument to scaffold the enum file.

3. **llm** — The enum should contain only the minimum amount of members to fulfill the requirements, following YAGNI principle.

## Evaluation loop

After the steps above, the enum must comply with the rules. Verify it with this loop:

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/enum/scripts/evaluate/step-2.ts <id> where <id> is the enum's id (it will be converted to PascalCase to resolve the enum file).

3. **llm** — 1. The members of the enum belong to a single closed set of values, any value that is not part of that set must be defined at its own enum.

4. **llm** — If every deterministic step of this loop exited 0, the loop is done.
   Otherwise fix every discrepancy they reported, editing the files as located by the rules,
   and restart the loop from its first step. Repeat until every deterministic step exits 0.
