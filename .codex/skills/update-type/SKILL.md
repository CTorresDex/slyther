---
name: update-type
description: Updates an existing type artifact's source file to satisfy a natural-language change request, given its id, erroring if the type doesn't exist.
---

# update type

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

1. **llm** — Input: <{id}> <change-request>

2. **deterministic** — Run .gstudio/artifacts/type/scripts/update/step-2.ts <id> to verify that the type identified by `<id>` exists before continuing the update action.

3. **llm** — Apply the change request to the content of the type files as located by the rules.
   Edit the files directly so they reflect the requested change while still complying with every rule.

## Evaluation loop

After the steps above, the type must comply with the rules. Verify it with this loop:

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/type/scripts/evaluate/step-2.ts <id> from the project root, passing the artifact's id as the sole argument.

3. **llm** — 1. The type describes only the shape of its own domain concept, any shared or general purpose shape must be extracted to its own type and referenced by import.

4. **llm** — If every deterministic step of this loop exited 0, the loop is done.
   Otherwise fix every discrepancy they reported, editing the files as located by the rules,
   and restart the loop from its first step. Repeat until every deterministic step exits 0.
