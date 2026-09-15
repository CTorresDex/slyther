---
name: list-class
description: "Lists all classes defined in the codebase, optionally filtered by a search term, printing each as \"[id]: [file path]\"."
---

# list class

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

1. **llm** — Input (Optional): search term

2. **deterministic** — Run .gstudio/artifacts/class/scripts/list/step-2.ts [searchTerm] to list all classes, optionally filtering to only those whose file contents include the given searchTerm.

3. **llm** — Report the results of the previous command.
