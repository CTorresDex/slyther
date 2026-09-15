ID: path

1. ALL Commands are defined at src/src/commands/{path}.command.ts, where {path} is slash separated and is substituted verbatim into that location: the `create artifact` command has the path create/artifact and is defined at src/src/commands/create/artifact.command.ts
2. The file must have EXACTLY two top level definitions, in this order: the named `help` const export and the anonymous default exported command function, and must follow the following template
3. `help.short` is a single line without a trailing period, shown for the command in the general listing printed by `gstudio help` and by `gstudio` with no arguments; `help.long` is a multi-line string shown by `gstudio help {path}`, opening with the usage line `Usage: gstudio {path} <args> [--flags]`, then what the command does, its arguments and its flags
4. A command only reads its input from args and context.flags, delegates every decision to the classes at src/src/classes and prints the outcome: no types, no helper functions and no variables other than `help` are defined at the top level of the file
5. Every script receives {path} as a single first argument, written exactly as it appears in the file location (create/artifact), never split into separate words and never needing quotes
6. A command that waits says what it is waiting for: every `await` in the body sits inside `Progress.of('{label}').run(() => ...)`, where {label} names the work in progress and its subject, as a string or a template literal naming what it is working on (`Reading the registry`, `Fetching ${args[0]}`, `Adding the feature ${args[0]}`). Work that moves on, or has something to report as it goes, is handed the indicator: `progress.say('...')` changes what it is waiting on, `progress.log(line)` prints a finished line above the animation. `Progress` is imported from src/src/classes/Progress.class.ts, relative to the command file as every other class is. It animates on stderr and erases itself when the work settles, so stdout carries the outcome alone and stays as readable to a script as it is to a person

```ts
import { Progress } from '{relative path back to src/src}/classes/Progress.class.ts'

export const help = {
    short: 'What the command does, in one line',
    long: `Usage: gstudio {path} <args> [--flags]

What the command does.

Arguments:
  <args>     what it is

Flags:
  --flag     what it does`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    const outcome = await Progress.of('{label}').run(() => Klass.work(args[0]))

    // command definition
}
```

## create

<llm>Input: command path ({path}) and optionally the content of the command</llm>
<deterministic>
    Scaffolds the command file as defined at the rules, exits 1 if the file already exists.
</deterministic>

## list

<llm>Input (Optional): search term</llm>
<deterministic>
    Lists all the commands defined in the codebase that contains the search term if provided in the commands folder as defined at the rules.
    Every file is a single command.

    The result is printed in the following format:

    [command path ({path})]: [file path]
</deterministic>
<llm>
    Report the results of the previous command.
</llm>

## update

<llm>Input: <command-path> <change-request></llm>
<deterministic>
    Exits 1 and prints error message if the command file does not exists.
</deterministic>

## delete

<llm>Input: command path ({path})</llm>
<deterministic>
    Removes the command file as defined at the rules, exits 1 if the file does not exists.
</deterministic>
<deterministic>
    Find all the existing references to the command in the codebase and print them to stdout in the following format:

    [file path]:[line number]
</deterministic>
<llm>
    Remove all the dangling references to the command, run the previous command to ensure all the references are gone. If not, fix it and run the command again.
</llm>

## evaluate

<llm>Input: command path ({path})</llm>
<deterministic>
    Evaluate that:

    1. The file has EXACTLY two top level definitions and no others: a named `export const help` object literal with a `short` string property and a `long` string property, followed by the anonymous default export of an async function taking the arguments of the template at the rules.
    2. If the body of the default exported function contains any `await`, every one of them is either the `await` of a `Progress.of({label}).run(...)` call, or written inside the function handed to such a `run`, and every `Progress.of` is given a single non-empty string or template literal.

    If it complies with all the rules, exits 0.
    Otherwise, iterate over each discrepancy, print them to stdout and exit with 1.
</deterministic>
<llm>
    Ensure that the command only reads its input from args and context.flags, delegates every decision to the classes at src/src/classes and prints the outcome.
    Ensure that every Progress label names the work the command is actually waiting on and its subject, rather than repeating the command path or saying something generic like 'Loading'.
    Ensure as well that help.short is a single descriptive line and that help.long opens with the usage line and documents the arguments the command reads from args and every flag it reads from context.flags.
</llm>
