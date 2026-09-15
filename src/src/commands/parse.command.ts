import { Progress } from '../classes/Progress.class.ts'
import { SlytherParser } from '../classes/SlytherParser.class.ts'
import { SlytherScript } from '../classes/SlytherScript.class.ts'

export const help = {
    short: 'Parse a SlytherScript and print it as JSON',
    long: `Usage: gstudio parse <file> [--flags]

Parses the given SlytherScript, resolving its imports relative to it, and prints the JSON
representation of the parsed script — every artifact it declares and the closure hash of each
one, keyed by kind:name — on stdout.

Arguments:
  <file>     the path of the SlytherScript to parse`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    const parsed = await Progress.of(`Parsing ${args[0]}`).run(async () =>
        new SlytherParser().parse(await SlytherScript.of(args[0]!)),
    )

    console.log(JSON.stringify(parsed, null, 4))
}
