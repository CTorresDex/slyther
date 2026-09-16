import { Progress } from '../classes/Progress.class.ts'
import { SlytherProject } from '../classes/SlytherProject.class.ts'

export const help = {
    short: 'Initialize a Slyther project in the current directory',
    long: `Usage: gstudio init [--flags]

Initializes a Slyther project in the current directory: creates ${SlytherProject.MAIN}, the entry point,
and ${SlytherProject.OUTPUT}, the folder of Slyther output files. Whatever already exists is left untouched,
so running it in a project that is already initialized does nothing.`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    const { project, created } = await Progress.of('Initializing the Slyther project').run(async () => SlytherProject.init())

    if (created.length === 0) return console.log(`Slyther project already initialized in ${project.root}`)

    console.log(`Initialized a Slyther project in ${project.root}`)
    for (const path of created) console.log(`  created ${path}`)
}
