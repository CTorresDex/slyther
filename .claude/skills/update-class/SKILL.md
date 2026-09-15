---
name: update-class
description: Updates an existing class artifact's source file according to a given id and natural-language change request, erroring if the class doesn't exist.
---

# update class

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

1. **llm** — Input: <{id}> <change-request>

2. **deterministic** — Run .gstudio/artifacts/class/scripts/update/step-2.ts <id> with the class's id as the argument to verify the class exists before proceeding.

3. **llm** — Apply the change request to the content of the class files as located by the rules.
   Edit the files directly so they reflect the requested change while still complying with every rule.

## Evaluation loop

After the steps above, the class must comply with the rules. Verify it with this loop:

1. **llm** — Input: {id}

2. **deterministic** — Run .gstudio/artifacts/class/scripts/evaluate/step-2.ts <id> where <id> is the class identifier to evaluate (e.g. `.gstudio/artifacts/class/scripts/evaluate/step-2.ts my-class`).

3. **llm** — 1. The functions defined in the class are only from the scope of the class, any general purpose utility function must be defined at the respective utils class called by the name of the type (StringUtils, FunctionUtils, NumberUtils, etc...)

4. **llm** — If every deterministic step of this loop exited 0, the loop is done.
   Otherwise fix every discrepancy they reported, editing the files as located by the rules,
   and restart the loop from its first step. Repeat until every deterministic step exits 0.
