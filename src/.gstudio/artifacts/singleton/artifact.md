ID: name

1. ALL Singletons are defined at src/singletons/{name}.singleton.ts, where name is the id written in camelCase.
2. The exported singleton is named ${name}, where name is the id written in camelCase.
3. Every singleton must have only one top level definition, the singleton. No helper functions, no types, no variables on the top level.
4. The singleton must strictly follow this shape:
```ts
// Imports

export const ${name (camelCase)} = // the single shared instance
```

## create

<llm>Input: {id} and optionally the instance the singleton holds</llm>
<deterministic lang="ts">
    Scaffolds the singleton as defined at the rules, exits 1 if it already exists.
</deterministic>
<llm>
    The singleton should contain only the minimum amount of code to fulfill the requirements, following YAGNI principle.
</llm>

## list

<llm>Input (Optional): search term</llm>
<deterministic lang="ts">
    Lists all the singletons defined in the codebase that contain the search term if provided, as located by the rules.

    The result is printed in the following format:

    [{id}]: [file path]
</deterministic>
<llm>
    Report the results of the previous command.
</llm>

## update

<llm>Input: <{id}> <change-request></llm>
<deterministic lang="ts">
    Exits 1 and prints error message if the singleton does not exist.
</deterministic>

## delete

<llm>Input: {id}</llm>
<deterministic lang="ts">
    Removes the singleton as defined at the rules, exits 1 if it does not exist.
</deterministic>
<deterministic>
    Find all the existing references to the singleton in the codebase and print them to stdout in the following format:

    [file path]:[line number]
</deterministic>
<llm>
    Remove all the dangling references to the singleton, run the previous command to ensure all the references are gone. If not, fix it and run the command again.
</llm>

## evaluate

<llm>Input: {id}</llm>
<deterministic lang="ts">
    Evaluate that:

    1. ALL Singletons are defined at src/singletons/{name}.singleton.ts, where name is the id written in camelCase.
    2. The exported singleton is named ${name}, where name is the id written in camelCase.
    3. Every singleton must have only one top level definition, the singleton. No helper functions, no types, no variables on the top level.
    4. The singleton follows strictly the top-level shape defined at the rules.


    If it complies with all the rules, exits 0.
    Otherwise, iterate over each discrepancy, print them to stdout and exit with 1.
    The print format is: [ERROR_CODE]: [ERROR_MESSAGE]
</deterministic>
<llm>
    1. The singleton is the only instance of its concept in the codebase, any value that needs more than one instance must be created by its own function.
</llm>
