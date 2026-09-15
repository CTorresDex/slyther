---
name: create-type
description: Scaffolds a new type file at src/types/{Name}.type.ts given a type id and optional initial definition, failing if the file already exists.
---

# create type

Every step below is either **deterministic** (run the script exactly as written, from the project root,
and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.
Follow the steps in order.

## Rules

ID: name

1. ALL Types are defined at src/types/{name}.type.ts, where name is the id written in PascalCase.
2. Every type must have only one top level definition, the type. No helper functions, no classes, no variables on the top level.
3. The type must strictly follow this shape:
```ts
// Imports

export type {name (PascalCase)} = {
    // type definition
}
```

## Steps

1. **llm** — Input: {id} and optionally the content of the type

2. **deterministic** — Run .gstudio/artifacts/type/scripts/create/step-2.ts <id> [content] to scaffold the type, where <id> is the type's identifier and the optional [content] is the body to place inside the type definition.

3. **llm** — The type should contain only the minimum amount of definition to fulfill the requirements, following YAGNI principle.

## Evaluation loop

After the steps above, the type must comply with the rules. Verify it with this loop:

1. **llm** — Input: {id}

2. **deterministic** — Run `.gstudio/artifacts/type/scripts/evaluate/step-2.ts <id>` where `<id>` is the type's identifier (e.g. `user`), to evaluate the corresponding type file against the rules.

3. **llm** — 1. The type describes only the shape of its own domain concept, any shared or general purpose shape must be extracted to its own type and referenced by import.

4. **llm** — If every deterministic step of this loop exited 0, the loop is done.
   Otherwise fix every discrepancy they reported, editing the files as located by the rules,
   and restart the loop from its first step. Repeat until every deterministic step exits 0.
