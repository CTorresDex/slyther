ID: name

1. ALL Enums are defined at src/enums/{name}.enum.ts, where name is the id written in PascalCase.
2. Every enum must have only one top level definition, the enum. No helper functions, no types, no variables on the top level.
3. The enum must strictly follow this shape:
```ts
export enum {name (PascalCase)} {
    // enum members
}
```

## create

<llm>Input: {id} and optionally the members of the enum</llm>
<deterministic lang="ts">
    Scaffolds the enum as defined at the rules, exits 1 if it already exists.
</deterministic>
<llm>
    The enum should contain only the minimum amount of members to fulfill the requirements, following YAGNI principle.
</llm>

## list

<llm>Input (Optional): search term</llm>
<deterministic lang="ts">
    Lists all the enums defined in the codebase that contain the search term if provided, as located by the rules.

    The result is printed in the following format:

    [{id}]: [file path]
</deterministic>
<llm>
    Report the results of the previous command.
</llm>

## update

<llm>Input: <{id}> <change-request></llm>
<deterministic lang="ts">
    Exits 1 and prints error message if the enum does not exist.
</deterministic>

## delete

<llm>Input: {id}</llm>
<deterministic lang="ts">
    Removes the enum as defined at the rules, exits 1 if it does not exist.
</deterministic>
<deterministic>
    Find all the existing references to the enum in the codebase and print them to stdout in the following format:

    [file path]:[line number]
</deterministic>
<llm>
    Remove all the dangling references to the enum, run the previous command to ensure all the references are gone. If not, fix it and run the command again.
</llm>

## evaluate

<llm>Input: {id}</llm>
<deterministic lang="ts">
    Evaluate that:

    1. ALL Enums are defined at src/enums/{name}.enum.ts, where name is the id written in PascalCase.
    2. Every enum must have only one top level definition, the enum. No helper functions, no types, no variables on the top level.
    3. The enum follows strictly the top-level shape defined at the rules.


    If it complies with all the rules, exits 0.
    Otherwise, iterate over each discrepancy, print them to stdout and exit with 1.
    The print format is: [ERROR_CODE]: [ERROR_MESSAGE]
</deterministic>
<llm>
    1. The members of the enum belong to a single closed set of values, any value that is not part of that set must be defined at its own enum.
</llm>
