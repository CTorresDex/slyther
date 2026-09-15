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
## create

<llm>Input: {id} and optionally the content of the class</llm>
<deterministic lang="ts">
    Scaffolds the class as defined at the rules, exits 1 if it already exists.
</deterministic>
<llm>
    The class should contain only the minimum amount of code to fulfill the requirements, following YAGNI principle.
</llm>

## list

<llm>Input (Optional): search term</llm>
<deterministic lang="ts">
    Lists all the classs defined in the codebase that contain the search term if provided, as located by the rules.

    The result is printed in the following format:

    [{id}]: [file path]
</deterministic>
<llm>
    Report the results of the previous command.
</llm>

## update

<llm>Input: <{id}> <change-request></llm>
<deterministic lang="ts">
    Exits 1 and prints error message if the class does not exist.
</deterministic>

## delete

<llm>Input: {id}</llm>
<deterministic lang="ts">
    Removes the class as defined at the rules, exits 1 if it does not exist.
</deterministic>
<deterministic>
    Find all the existing references to the class in the codebase and print them to stdout in the following format:

    [file path]:[line number]
</deterministic>
<llm>
    Remove all the dangling references to the class, run the previous command to ensure all the references are gone. If not, fix it and run the command again.
</llm>

## evaluate

<llm>Input: {id}</llm>
<deterministic lang="ts">
    Evaluate that:

    1. ALL Classes are defined at src/classes/{name}.class.ts, where name is the id written in PascalCase.
    2. Every class must have only one top level definition, the class. No helper functions, no types, no variables on the top level.
    3. The class follows strictly the top-level shape defined at the rules.


    If it complies with all the rules, exits 0.
    Otherwise, iterate over each discrepancy, print them to stdout and exit with 1.
    The print format is: [ERROR_CODE]: [ERROR_MESSAGE]
</deterministic>
<llm>
    1. The functions defined in the class are only from the scope of the class, any general purpose utility function must be defined at the respective utils class called by the name of the type (StringUtils, FunctionUtils, NumberUtils, etc...)
</llm>
