import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A command, as an object. Commands are files, not registrations: every `src/commands/**\/*.command.ts`
 * is a command whose name is its path — `compile artifact` is `src/commands/compile/artifact.command.ts` —
 * so they are found by walking the tree, and each one is asked for what it exports: the `help` it is
 * documented by and the function it runs.
 */
export class Command {
    /** Where commands live. Resolved from this file so the CLI works from any working directory. */
    static readonly ROOT = join(import.meta.dir, '..', 'commands')
    /** What makes a file a command. */
    static readonly SUFFIX = '.command.ts'

    private constructor(
        /** The command as it must be typed: the words of its path, separated by spaces. */
        readonly path: string,
        /** The file the command is defined in. */
        readonly file: string,
    ) {}

    /** Every command there is, in the order they are typed. */
    static async all(dir: string = Command.ROOT, prefix: string[] = []): Promise<Command[]> {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
        const commands: Command[] = []

        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isDirectory()) commands.push(...(await Command.all(join(dir, entry.name), [...prefix, entry.name])))
            else if (entry.name.endsWith(Command.SUFFIX)) commands.push(new Command([...prefix, entry.name.slice(0, -Command.SUFFIX.length)].join(' '), join(dir, entry.name)))
        }

        return commands
    }

    /**
     * Walks the words until one of them names a file, and hands back the command it names with the rest
     * as its arguments, or null when no file matches.
     */
    static async resolve(segments: string[]): Promise<{ command: Command; args: string[] } | null> {
        let dir = Command.ROOT

        for (const [index, segment] of segments.entries()) {
            const file = join(dir, `${segment}${Command.SUFFIX}`)

            if (await Bun.file(file).exists()) return { command: new Command([...segments.slice(0, index), segment].join(' '), file), args: segments.slice(index + 1) }

            dir = join(dir, segment)
        }

        return null
    }

    /** Every command whose path starts with the given words, so `help compile` names all of them. */
    static async matching(segments: string[]): Promise<Command[]> {
        const prefix = segments.join(' ')

        return (await Command.all()).filter((command) => command.path === prefix || command.path.startsWith(`${prefix} `))
    }

    /** The function the command runs. Throws when the file does not export one. */
    async handler(): Promise<(args: string[], context: { flags: Record<string, string | boolean> }) => unknown> {
        const handler = (await import(this.file)).default

        if (typeof handler !== 'function') throw new Error(`Command ${this.file} must have a default export function`)

        return handler
    }

    /** The help the command exports: one line for the listing and the detailed text, or null when it documents neither. */
    async help(): Promise<{ short: string; long: string } | null> {
        const help = (await import(this.file)).help

        if (help === undefined || typeof help.short !== 'string' || typeof help.long !== 'string') return null

        return { short: help.short, long: help.long }
    }
}
