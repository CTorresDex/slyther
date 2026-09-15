---
name: create-class
description: Scaffolds a new class file at src/classes/{Name}.class.ts given a class id and optional initial content, failing if it already exists.
---

# create class

Every step below is either **deterministic** (run the script exactly as written, from the project root,
and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.
Follow the steps in order.

## Rules

ID: name

1. ALL Classes are defined at src/classes/{name}.class.ts, where name is the id written in PascalCase.
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

1. **llm** — Input: {id} and optionally the content of the class

2. **deterministic** — Run .gstudio/artifacts/class/scripts/create/step-2.ts <id> to scaffold the class, where <id> is the class identifier (e.g. kebab-case or camelCase) to convert to PascalCase for the generated file.

3. **llm** — The class should contain only the minimum amount of code to fulfill the requirements, following YAGNI principle.

## Evaluation loop

After the steps above, the class must comply with the rules. Verify it with this loop:

1. **llm** — Input: {id}

2. **deterministic** — Run `.gstudio/artifacts/class/scripts/evaluate/step-2.ts <id>` where `<id>` is the class identifier to evaluate against `src/classes/{PascalCaseId}.class.ts`.

3. **llm** — 1. The functions defined in the class are only from the scope of the class, any general purpose utility function must be defined at the respective utils class called by the name of the type (StringUtils, FunctionUtils, NumberUtils, etc...)

4. **llm** — If every deterministic step of this loop exited 0, the loop is done.
   Otherwise fix every discrepancy they reported, editing the files as located by the rules,
   and restart the loop from its first step. Repeat until every deterministic step exits 0.
