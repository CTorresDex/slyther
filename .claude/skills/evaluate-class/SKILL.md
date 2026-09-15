---
name: evaluate-class
description: Checks that a class artifact's file, structure, and shape comply with the artifact rules, given the class's id, and reports pass/fail with any discrepancies.
---

# evaluate class

Every step below is either **deterministic** (run the script exactly as written, from the project root,
and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.
Follow the steps in order.

## Rules

ID: name

1. ALL Classes are defined at src/src/classes/{name}.class.ts, where name is the id written in PascalCase.
2. Every class must have only one top level definition, the class. No helper functions, no types, no variables on the top level.
3. The functions defined in the class are only from the scope of the class, any general purpose utility function must be defined at the respective utils class called by the name of the type (StringUtils, FunctionUtils, NumberUtils, etc...)

4. The class must strictly follow this shape:
```ts
// Imports 

export class {name (PascalCase)} {
    // class definition
}
```

## Steps

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/class/scripts/evaluate/step-2.ts <id> where <id> is the class identifier to evaluate (e.g. `.gstudio/artifacts/class/scripts/evaluate/step-2.ts my-class`).

3. **llm** — 1. The functions defined in the class are only from the scope of the class, any general purpose utility function must be defined at the respective utils class called by the name of the type (StringUtils, FunctionUtils, NumberUtils, etc...)
