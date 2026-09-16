import { ClaudeCLI } from '../classes/ClaudeCLI.class.ts'
import { Progress } from '../classes/Progress.class.ts'
import { SlytherArtifactKind } from '../classes/SlytherArtifactKind.class.ts'
import { SlytherCompiler } from '../classes/SlytherCompiler.class.ts'
import { SlytherParser } from '../classes/SlytherParser.class.ts'
import { SlytherScript } from '../classes/SlytherScript.class.ts'

export const help = {
    short: 'Compile the kinds of a SlytherScript into scripts and skills',
    long: `Usage: gstudio compile <file> [--model <model>]

Parses the given SlytherScript and compiles every kind it defines: a script for each deterministic
step under .slyther/artifacts/{kind}/{operation}/{step}, written by the Claude CLI, and a skill for
each operation under .claude/skills and .codex/skills. Scripts and descriptions are only asked for
again when what they were generated from has changed, as recorded in .slyther/compiled.json.
Paths are relative to the current directory, which must be the project root.

Arguments:
  <file>     the path of the SlytherScript to compile

Flags:
  --model    the model the Claude CLI asks, defaulting to the CLI's own`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    const outcome = await Progress.of(`Compiling ${args[0]}`).run(async (progress) => {
        const kinds = SlytherArtifactKind.of(new SlytherParser().parse(await SlytherScript.of(args[0]!)))
        const claude = new ClaudeCLI(typeof context.flags.model === 'string' ? context.flags.model : '')

        progress.say(`Compiling the kinds of ${args[0]}`)

        return new SlytherCompiler(process.cwd(), claude, (line) => progress.log(line)).compile(kinds)
    })

    console.log(`${outcome.generated} generated, ${outcome.reused} reused, ${outcome.skills} skills written`)
}
