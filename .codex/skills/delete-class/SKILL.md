---
name: delete-class
description: Deletes the class artifact with the given id from src/src/classes, removing its file and cleaning up any dangling references to it in the codebase.
---

# delete class

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

2. **deterministic** — Run .gstudio/artifacts/class/scripts/delete/step-2.ts <id> with the class's id (e.g. its kebab/camel-case name) as the argument.

3. **deterministic** — Run .gstudio/artifacts/class/scripts/delete/step-3.sh <id> with the class's id (the same id used to create/delete it) to print every remaining reference as `[file path]:[line number]`.

4. **llm** — Remove all the dangling references to the class, run the previous command to ensure all the references are gone. If not, fix it and run the command again.
