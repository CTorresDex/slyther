import { SlytherProject } from '../classes/SlytherProject.class.ts'

export const help = {
    short: 'Run a script of the Slyther project',
    long: `Usage: slyther run [script] [args...]

Runs a script declared with @run, as built into ${SlytherProject.OUTPUT}/${SlytherProject.ARTIFACTS}, with the args as
its params, in the order the script declares them. Its steps run in order from ${SlytherProject.OUTPUT}/${SlytherProject.SOURCE}
in this terminal, and it exits with the code of the first one that fails.

The first arg names the script when a script of that name is built, otherwise every arg belongs to the
script declared with no name, the default one.

Arguments:
  [script]      the name of the script, default when omitted
  [args...]     the params of the script, in order`,
}

export default async function (args: string[]) {
    const project = new SlytherProject(process.cwd())
    const [first, ...rest] = args
    const named = first !== undefined && (await project.scripts()).includes(first)

    process.exitCode = named ? await project.run(first, rest) : await project.run(undefined, args)
}
