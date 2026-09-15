---
name: list-singleton
description: "Lists singleton artifacts under src/singletons matching an optional search term, printing each as id: file path."
---

# list singleton

Every step below is either **deterministic** (run the script exactly as written, from the project root,
and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.
Follow the steps in order.

## Rules

ID: name

1. ALL Singletons are defined at src/singletons/{name}.singleton.ts, where name is the id written in camelCase.
2. The exported singleton is named ${name}, where name is the id written in camelCase.
3. Every singleton must have only one top level definition, the singleton. No helper functions, no types, no variables on the top level.
4. The singleton must strictly follow this shape:
```ts
// Imports

export const ${name (camelCase)} = // the single shared instance
```

## Steps

1. **llm** — Input (Optional): search term

2. **deterministic** — Run `.gstudio/artifacts/singleton/scripts/list/step-2.ts [search term]`, optionally passing a search term to filter singletons whose file contents include it.

3. **llm** — Report the results of the previous command.
