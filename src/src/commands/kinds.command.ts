import { Progress } from '../classes/Progress.class.ts'
import { SlytherArtifactKind } from '../classes/SlytherArtifactKind.class.ts'
import { SlytherParser } from '../classes/SlytherParser.class.ts'
import { SlytherScript } from '../classes/SlytherScript.class.ts'

export const help = {
    short: 'Parse a SlytherScript and print the kinds it defines as JSON',
    long: `Usage: gstudio kinds <file> [--flags]

Parses the given SlytherScript, resolving its imports relative to it, groups its artifacts into
the kinds they define and prints them as JSON on stdout: every kind with its rules, its closure
hash and its operations, and every operation with its steps in the order written.

Arguments:
  <file>     the path of the SlytherScript to read`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    const kinds = await Progress.of(`Reading the kinds of ${args[0]}`).run(async () =>
        SlytherArtifactKind.of(new SlytherParser().parse(await SlytherScript.of(args[0]!))),
    )

    console.log(JSON.stringify(kinds, null, 4))
}
