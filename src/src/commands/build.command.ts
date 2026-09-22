import { Progress } from '../classes/Progress.class.ts'
import { SlytherProject } from '../classes/SlytherProject.class.ts'

export const help = {
    short: 'Compile the Slyther project in the current directory',
    long: `Usage: slyther build [--max <n>] [--fixes <n>] [--verbose]

Compiles the Slyther project in the current directory. Parses ${SlytherProject.MAIN}, resolving its imports
relative to it, writes the JSON representation of the parsed script to ${SlytherProject.OUTPUT}/${SlytherProject.BUILD}/parser.json,
and builds the operations of every kind into ${SlytherProject.OUTPUT}/${SlytherProject.ARTIFACTS}: a script per
deterministic step, written by the LLM and verified, and a markdown per llm step and per operation that is
not deterministic. A manifest remembers what every file was built from, so only what changed is built again.

Then it brings every instance the scripts declare in line with its declaration, in ${SlytherProject.OUTPUT}/${SlytherProject.SOURCE}:
one that is missing is created with the create operation of its kind, and every one that changed is
brought in line with its update operation and then evaluated with its evaluate operation, since the
prose rules over the code and an evaluate only ever covers part of what the prose says. An instance
changed when its own prose changed, when the rules of its kind changed, when its code was edited by
hand, or when something it depends on changed in a way it uses; one with no record yet, or whose
evaluate is all that changed, is evaluated as it stands, and one that fails is updated with the errors and
evaluated once more, up to --fixes times, each update resuming the session of the one before it and
none once an update changes nothing. What it finds is recorded in ${SlytherProject.OUTPUT}/${SlytherProject.INSTANCES}, so
the next build only works on what changed. An instance of a composite kind is expanded first, and what it
emits is built under it; what its parent no longer emits is reported as an orphan and left alone. Exits 1
when any instance fails or is missing.

Flags:
  --verbose    print every prompt sent to the LLM and every reply, as they happen
  --max <n>    refuse to create, update or evaluate more than n instances with the LLM in one run
  --fixes <n>  update a failing instance with its errors up to n times, 2 unless given, 0 to never`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    const max = context.flags.max === undefined ? undefined : Number(context.flags.max)

    if (max !== undefined && !Number.isInteger(max)) throw new Error('--max takes a whole number')

    const fixes = context.flags.fixes === undefined ? undefined : Number(context.flags.fixes)

    if (fixes !== undefined && (!Number.isInteger(fixes) || fixes < 0)) throw new Error('--fixes takes a whole number')

    const { files, instances } = await Progress.of('Building').run(async (progress) =>
        new SlytherProject(process.cwd(), undefined, progress, { verbose: context.flags.verbose === true }).build({ max, fixes }),
    )
    const failed = instances.filter((entry) => entry.status === 'fail' || entry.status === 'missing')

    console.log(`Built the Slyther project in ${process.cwd()}`)
    for (const entry of files) console.log(`  ${entry.status.padEnd(7)} ${entry.path}`)

    console.log('Instances:')
    for (const entry of instances) {
        console.log(`  ${entry.parent ? '  ' : ''}${entry.status.padEnd(8)} ${entry.key}${entry.reason ? ` (${entry.reason})` : ''}`)
        for (const error of entry.errors) console.log(`  ${entry.parent ? '  ' : ''}         - ${error}`)
    }

    console.log(`${instances.length - failed.length} of ${instances.length} instances comply`)

    process.exitCode = failed.length > 0 ? 1 : 0
}
