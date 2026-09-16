import { Progress } from '../classes/Progress.class.ts'
import { SlytherProject } from '../classes/SlytherProject.class.ts'

export const help = {
    short: 'Check that every declared artifact complies with the rules of its kind',
    long: `Usage: slyther check [--fix] [--max <n>]

Builds the project, then checks every artifact the scripts declare whose kind has operations: locates it
in the code, and evaluates it with the evaluate operation of its kind when it was never evaluated, when
its code changed, when what evaluates it changed, or when an artifact it references changed in a way it
uses. What it finds is recorded in ${SlytherProject.OUTPUT}/${SlytherProject.INSTANCES}, so the next check
only evaluates what changed. Exits 1 when any artifact fails or is missing.

Flags:
  --fix        update every artifact that fails with the update operation of its kind, and evaluate it again
  --max <n>    refuse to evaluate more than n artifacts with the LLM in one run`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    const max = context.flags.max === undefined ? undefined : Number(context.flags.max)

    if (max !== undefined && !Number.isInteger(max)) throw new Error('--max takes a whole number')

    const report = await Progress.of('Checking').run(async (progress) =>
        new SlytherProject(process.cwd(), undefined, (line) => progress.log(line)).check({ fix: context.flags.fix === true, max }),
    )
    const failed = report.filter((entry) => entry.status === 'fail' || entry.status === 'missing')

    for (const entry of report) {
        console.log(`  ${entry.status.padEnd(7)} ${entry.key}${entry.reason ? ` (${entry.reason})` : ''}`)
        for (const error of entry.errors) console.log(`          - ${error}`)
    }

    console.log(`${report.length - failed.length} of ${report.length} artifacts comply`)

    process.exitCode = failed.length > 0 ? 1 : 0
}
