---
name: update-singleton
description: Updates an existing singleton's source file to satisfy a natural-language change request, given its id, erroring if the singleton doesn't exist.
---

# update singleton

Every step below is either **deterministic** (run the script exactly as written, from the project root,
and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.
Follow the steps in order.

## Rules

ID: name

1. ALL Singletons are defined at src/src/singletons/{name}.singleton.ts, where name is the id written in camelCase.
2. The exported singleton is named ${name}, where name is the id written in camelCase.
3. Every singleton must have only one top level definition, the singleton. No helper functions, no types, no variables on the top level.
4. The singleton must strictly follow this shape:
```ts
// Imports

export const ${name (camelCase)} = // the single shared instance
```

## Steps

1. **llm** — Input: <{id}> <change-request>

2. **deterministic** — Run .gstudio/artifacts/singleton/scripts/update/step-2.ts <id> <change-request> to verify the singleton identified by `<id>` exists before it is updated.

3. **llm** — Apply the change request to the content of the singleton files as located by the rules.
   Edit the files directly so they reflect the requested change while still complying with every rule.

## Evaluation loop

After the steps above, the singleton must comply with the rules. Verify it with this loop:

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/singleton/scripts/evaluate/step-2.ts <id> where <id> is the singleton's id, e.g. `.gstudio/artifacts/singleton/scripts/evaluate/step-2.ts userSession`.

3. **llm** — 1. The singleton is the only instance of its concept in the codebase, any value that needs more than one instance must be created by its own function.

4. **llm** — If every deterministic step of this loop exited 0, the loop is done.
   Otherwise fix every discrepancy they reported, editing the files as located by the rules,
   and restart the loop from its first step. Repeat until every deterministic step exits 0.
