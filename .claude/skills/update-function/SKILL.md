---
name: update-function
description: Modifies an existing function file at src/functions/{name}.function.ts to satisfy a given change request, erroring if the function does not exist.
---

# update function

Every step below is either **deterministic** (run the script exactly as written, from the project root,
and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.
Follow the steps in order.

## Rules

ID: name

1. ALL Functions are defined at src/functions/{name}.function.ts, where name is the id written in camelCase.
2. Every function must have only one top level definition, the function. No helper functions, no types, no variables on the top level.
3. The function must strictly follow this shape:
```ts
// Imports

export function {name (camelCase)}() {
    // function definition
}
```

## Steps

1. **llm** — Input: <{id}> <change-request>

2. **deterministic** — Run .gstudio/artifacts/function/scripts/update/step-2.ts <id> <change-request> to verify the function identified by `<id>` exists before proceeding with the update.

3. **llm** — Apply the change request to the content of the function files as located by the rules.
   Edit the files directly so they reflect the requested change while still complying with every rule.

## Evaluation loop

After the steps above, the function must comply with the rules. Verify it with this loop:

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/function/scripts/evaluate/step-2.ts <id> where <id> is the function's id, to evaluate the function file at src/functions/{camelCase(id)}.function.ts against the file-location, single-top-level-definition, and shape rules.

3. **llm** — 1. The function does only what its name says, any other responsibility must be extracted to its own function and called by import.

4. **llm** — If every deterministic step of this loop exited 0, the loop is done.
   Otherwise fix every discrepancy they reported, editing the files as located by the rules,
   and restart the loop from its first step. Repeat until every deterministic step exits 0.
