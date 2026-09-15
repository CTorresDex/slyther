ID: name

1. ALL Types are defined at src/src/types/{name}.type.ts, where name is the id written in PascalCase.
2. Every type must have only one top level definition, the type. No helper functions, no classes, no variables on the top level.
3. The type must strictly follow this shape:
```ts
// Imports

export type {name (PascalCase)} = {
    // type definition
}
```

## create

<llm>Input: {id} and optionally the content of the type</llm>
<deterministic lang="ts">
    Scaffolds the type as defined at the rules, exits 1 if it already exists.
</deterministic>
<llm>
    The type should contain only the minimum amount of definition to fulfill the requirements, following YAGNI principle.
</llm>

## list

<llm>Input (Optional): search term</llm>
<deterministic lang="ts">
    Lists all the types defined in the codebase that contain the search term if provided, as located by the rules.

    The result is printed in the following format:

    [{id}]: [file path]
</deterministic>
<llm>
    Report the results of the previous command.
</llm>

## update

<llm>Input: <{id}> <change-request></llm>
<deterministic lang="ts">
    Exits 1 and prints error message if the type does not exist.
</deterministic>

## delete

<llm>Input: {id}</llm>
<deterministic lang="ts">
    Removes the type as defined at the rules, exits 1 if it does not exist.
</deterministic>
<deterministic>
    Find all the existing references to the type in the codebase and print them to stdout in the following format:

    [file path]:[line number]
</deterministic>
<llm>
    Remove all the dangling references to the type, run the previous command to ensure all the references are gone. If not, fix it and run the command again.
</llm>

## evaluate

<llm>Input: {id}</llm>
<deterministic lang="ts">
    Evaluate that:

    1. ALL Types are defined at src/src/types/{name}.type.ts, where name is the id written in PascalCase.
    2. Every type must have only one top level definition, the type. No helper functions, no classes, no variables on the top level.
    3. The type follows strictly the top-level shape defined at the rules.


    If it complies with all the rules, exits 0.
    Otherwise, iterate over each discrepancy, print them to stdout and exit with 1.
    The print format is: [ERROR_CODE]: [ERROR_MESSAGE]
</deterministic>
<llm>
    1. The type describes only the shape of its own domain concept, any shared or general purpose shape must be extracted to its own type and referenced by import.
</llm>
