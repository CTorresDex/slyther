---
name: delete-singleton
description: Deletes a singleton artifact by id, removing its file and cleaning up dangling references to it across the codebase.
---

# delete singleton

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

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/singleton/scripts/delete/step-2.ts <id> to delete the singleton with the given id, exiting with an error if it does not exist.

3. **deterministic** — Run .gstudio/artifacts/singleton/scripts/delete/step-3.sh <id> to print every `[file path]:[line number]` reference to the singleton's camelCase identifier found in the codebase.

4. **llm** — Remove all the dangling references to the singleton, run the previous command to ensure all the references are gone. If not, fix it and run the command again.
