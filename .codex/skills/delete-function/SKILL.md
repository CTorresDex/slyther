---
name: delete-function
description: Deletes a function artifact by id, removing its file and cleaning up any dangling references to it across the codebase.
---

# delete function

Every step below is either **deterministic** (run the script exactly as written, from the project root,
and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.
Follow the steps in order.

## Rules

ID: name

1. ALL Functions are defined at src/src/functions/{name}.function.ts, where name is the id written in camelCase.
2. Every function must have only one top level definition, the function. No helper functions, no types, no variables on the top level.
3. The function must strictly follow this shape:
```ts
// Imports

export function {name (camelCase)}() {
    // function definition
}
```

## Steps

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/function/scripts/delete/step-2.ts <id> to delete the function file corresponding to the given id.

3. **deterministic** — Run .gstudio/artifacts/function/scripts/delete/step-3.sh <id> to print, in `file:line` format, every existing reference to the function derived from `<id>`.

4. **llm** — Remove all the dangling references to the function, run the previous command to ensure all the references are gone. If not, fix it and run the command again.
