import { Progress } from '../classes/Progress.class.ts'
import { SlytherProject } from '../classes/SlytherProject.class.ts'

export const help = {
    short: 'Build the Slyther project in the current directory',
    long: `Usage: gstudio build [--flags]

Builds the Slyther project in the current directory into ${SlytherProject.OUTPUT}/${SlytherProject.BUILD}: parses
${SlytherProject.MAIN}, resolving its imports relative to it, and writes the JSON representation of the
parsed script to parser.json.`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    const project = new SlytherProject(process.cwd())
    const written = await Progress.of(`Building ${project.root}`).run(async () => project.build())

    console.log(`Built the Slyther project in ${project.root}`)
    for (const path of written) console.log(`  wrote ${path}`)
}
