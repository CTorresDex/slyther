import { Progress } from '../classes/Progress.class.ts'
import { SlytherProject } from '../classes/SlytherProject.class.ts'

export const help = {
    short: 'Check that every declared instance complies with its declaration and the rules of its kind',
    long: `Usage: slyther check [--max <n>]

Builds the operations of every kind, then checks every instance the scripts declare whose kind has
operations, without touching the code: locates it in ${SlytherProject.OUTPUT}/${SlytherProject.SOURCE}, and evaluates it
with the evaluate operation of its kind when it was never evaluated, when its declaration or its code
changed, when what evaluates it changed, or when an instance it references changed in a way it uses.
What it finds is recorded in ${SlytherProject.OUTPUT}/${SlytherProject.INSTANCES}, so the next check only evaluates
what changed. Exits 1 when any instance fails or is missing; run build to create and update them.

Flags:
  --max <n>    refuse to evaluate more than n instances with the LLM in one run`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    const max = context.flags.max === undefined ? undefined : Number(context.flags.max)

    if (max !== undefined && !Number.isInteger(max)) throw new Error('--max takes a whole number')

    const report = await Progress.of('Checking').run(async (progress) =>
        new SlytherProject(process.cwd(), undefined, (line) => progress.log(line)).check({ max }),
    )
    const failed = report.filter((entry) => entry.status === 'fail' || entry.status === 'missing')

    for (const entry of report) {
        console.log(`  ${entry.status.padEnd(7)} ${entry.key}${entry.reason ? ` (${entry.reason})` : ''}`)
        for (const error of entry.errors) console.log(`          - ${error}`)
    }

    console.log(`${report.length - failed.length} of ${report.length} instances comply`)

    process.exitCode = failed.length > 0 ? 1 : 0
}
