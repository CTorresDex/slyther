---
name: evaluate-command
description: Checks that a command artifact's file structure, Progress usage, and input handling comply with the artifact rules, given its command path, printing pass or itemized rule violations.
---

# evaluate command

Every step below is either **deterministic** (run the script exactly as written, from the project root,
and use its exit code and output) or **llm** (reason and act yourself). Never treat a step as the other kind.
Follow the steps in order.

## Rules

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

## Steps

1. **llm** — Input: command path ({path})

2. **deterministic** — Run .gstudio/artifacts/command/scripts/evaluate/step-2.sh <path> where <path> is the command's slash-separated path exactly as it appears in its file location (e.g. `create/artifact`), with no quoting needed.

3. **llm** — Ensure that the command only reads its input from args and context.flags, delegates every decision to the classes at src/src/classes and prints the outcome.
   Ensure that every Progress label names the work the command is actually waiting on and its subject, rather than repeating the command path or saying something generic like 'Loading'.
   Ensure as well that help.short is a single descriptive line and that help.long opens with the usage line and documents the arguments the command reads from args and every flag it reads from context.flags.
