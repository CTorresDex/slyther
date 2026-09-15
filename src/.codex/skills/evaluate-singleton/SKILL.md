---
name: evaluate-singleton
description: Checks a singleton's file location, naming, single top-level definition, and required shape against the rules, given a singleton id, and reports pass or itemized errors.
---

# evaluate singleton

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

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/singleton/scripts/evaluate/step-2.ts <id> where <id> is the singleton's identifier, to evaluate the corresponding src/singletons/{name}.singleton.ts file against the singleton rules.

3. **llm** — 1. The singleton is the only instance of its concept in the codebase, any value that needs more than one instance must be created by its own function.
