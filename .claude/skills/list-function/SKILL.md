---
name: list-function
description: "Lists functions defined in the codebase matching an optional search term, printing each as [id]: [file path]."
---

# list function

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

1. **llm** — Input (Optional): search term

2. **deterministic** — Run .gstudio/artifacts/function/scripts/list/step-2.ts [search term] to list all functions, optionally filtering to those whose file content contains the given search term.

3. **llm** — Report the results of the previous command.
