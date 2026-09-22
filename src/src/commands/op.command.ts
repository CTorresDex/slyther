import { SlytherProviders } from '../classes/SlytherProviders.class.ts'
import { SlytherProject } from '../classes/SlytherProject.class.ts'

export const help = {
    short: 'Run an operation of a kind built by the project',
    long: `Usage: slyther op <kind> <operation> [args...] [--execute]

Runs the operation of the kind as built into ${SlytherProject.OUTPUT}/${SlytherProject.ARTIFACTS}, with the
args as its params, in the order the operation declares them. A deterministic operation runs its scripts
in order from ${SlytherProject.OUTPUT}/${SlytherProject.SOURCE}, the folder the code of the project lives in,
and exits with the code of the first one that fails. An operation that is not deterministic prints the
markdown that orchestrates it, with the params substituted, or runs it through the LLM when --execute is given.

Arguments:
  <kind>        the kind of artifact
  <operation>   the operation of the kind
  [args...]     the params of the operation, in order

Flags:
  --execute     run the markdown of an operation that is not deterministic through the LLM`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    const [kind, operation, ...params] = args

    if (!kind || !operation) throw new Error('Usage: slyther op <kind> <operation> [args...]')

    const project = new SlytherProject(process.cwd())
    const result = await project.runOperation(kind, operation, params, {
        execute: context.flags.execute === true ? new SlytherProviders() : undefined,
    })

    if (result.output) process.stdout.write(result.output)

    process.exitCode = result.code
}
