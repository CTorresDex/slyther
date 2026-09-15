---
name: update-enum
description: Updates an existing enum artifact's source file to satisfy a natural-language change request, given its id, erroring if the enum doesn't exist.
---

# update enum

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

1. **llm** — Input: <{id}> <change-request>

2. **deterministic** — Run .gstudio/artifacts/enum/scripts/update/step-2.ts <id> <change-request> to verify the enum identified by `<id>` exists before applying the change request.

3. **llm** — Apply the change request to the content of the enum files as located by the rules.
   Edit the files directly so they reflect the requested change while still complying with every rule.

## Evaluation loop

After the steps above, the enum must comply with the rules. Verify it with this loop:

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/enum/scripts/evaluate/step-2.ts <id> to evaluate the enum artifact identified by <id> (its PascalCase name resolves the file at src/src/enums/{Name}.enum.ts).

3. **llm** — 1. The members of the enum belong to a single closed set of values, any value that is not part of that set must be defined at its own enum.

4. **llm** — If every deterministic step of this loop exited 0, the loop is done.
   Otherwise fix every discrepancy they reported, editing the files as located by the rules,
   and restart the loop from its first step. Repeat until every deterministic step exits 0.
