---
name: evaluate-function
description: Checks that a function artifact's file location, single top-level definition, and required export shape comply with the function rules, given a function id.
---

# evaluate function

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

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/function/scripts/evaluate/step-2.ts <id> where <id> is the function's id, to evaluate the function file at src/functions/{camelCase(id)}.function.ts against the file-location, single-top-level-definition, and shape rules.

3. **llm** — 1. The function does only what its name says, any other responsibility must be extracted to its own function and called by import.
