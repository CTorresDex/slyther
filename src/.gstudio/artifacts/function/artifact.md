ID: name

1. ALL Functions are defined at src/functions/{name}.function.ts, where name is the id written in camelCase.
2. Every function must have only one top level definition, the function. No helper functions, no types, no variables on the top level.
3. The function must strictly follow this shape:
```ts
// Imports

export function {name (camelCase)}() {
    // function definition
}
```

## create

<llm>Input: {id} and optionally the content of the function</llm>
<deterministic lang="ts">
    Scaffolds the function as defined at the rules, exits 1 if it already exists.
</deterministic>
<llm>
    The function should contain only the minimum amount of code to fulfill the requirements, following YAGNI principle.
</llm>

## list

<llm>Input (Optional): search term</llm>
<deterministic lang="ts">
    Lists all the functions defined in the codebase that contain the search term if provided, as located by the rules.

    The result is printed in the following format:

    [{id}]: [file path]
</deterministic>
<llm>
    Report the results of the previous command.
</llm>

## update

<llm>Input: <{id}> <change-request></llm>
<deterministic lang="ts">
    Exits 1 and prints error message if the function does not exist.
</deterministic>

## delete

<llm>Input: {id}</llm>
<deterministic lang="ts">
    Removes the function as defined at the rules, exits 1 if it does not exist.
</deterministic>
<deterministic>
    Find all the existing references to the function in the codebase and print them to stdout in the following format:

    [file path]:[line number]
</deterministic>
<llm>
    Remove all the dangling references to the function, run the previous command to ensure all the references are gone. If not, fix it and run the command again.
</llm>

## evaluate

<llm>Input: {id}</llm>
<deterministic lang="ts">
    Evaluate that:

    1. ALL Functions are defined at src/functions/{name}.function.ts, where name is the id written in camelCase.
    2. Every function must have only one top level definition, the function. No helper functions, no types, no variables on the top level.
    3. The function follows strictly the top-level shape defined at the rules.


    If it complies with all the rules, exits 0.
    Otherwise, iterate over each discrepancy, print them to stdout and exit with 1.
    The print format is: [ERROR_CODE]: [ERROR_MESSAGE]
</deterministic>
<llm>
    1. The function does only what its name says, any other responsibility must be extracted to its own function and called by import.
</llm>
