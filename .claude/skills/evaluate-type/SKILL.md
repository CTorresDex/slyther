---
name: evaluate-type
description: Checks that a type artifact's file location, single top-level shape, and domain-only scope comply with the rules, given the type's id, printing pass or itemized rule violations.
---

# evaluate type

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

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/type/scripts/evaluate/step-2.ts <id> from the project root, passing the artifact's id as the sole argument.

3. **llm** — 1. The type describes only the shape of its own domain concept, any shared or general purpose shape must be extracted to its own type and referenced by import.
