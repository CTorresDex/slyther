import { Progress } from '../classes/Progress.class.ts'
import { SlytherProject } from '../classes/SlytherProject.class.ts'

export const help = {
    short: 'Build the Slyther project in the current directory',
    long: `Usage: slyther build [--flags]

Builds the Slyther project in the current directory: parses ${SlytherProject.MAIN}, resolving its imports
relative to it, writes the JSON representation of the parsed script to ${SlytherProject.OUTPUT}/${SlytherProject.BUILD}/parser.json,
and builds the operations of every kind into ${SlytherProject.OUTPUT}/${SlytherProject.ARTIFACTS}: a script per
deterministic step, written by the LLM and verified, and a markdown per llm step and per operation that is
not deterministic. A manifest remembers what every file was built from, so only what changed is built again.`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    const report = await Progress.of('Building').run(async (progress) =>
        new SlytherProject(process.cwd(), undefined, (line) => progress.log(line)).build(),
    )

    console.log(`Built the Slyther project in ${process.cwd()}`)
    for (const entry of report) console.log(`  ${entry.status.padEnd(7)} ${entry.path}`)
}
