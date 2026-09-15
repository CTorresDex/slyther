import { Command } from './Command.class.ts'

/**
 * What `gstudio help` prints. Every command documents itself with the `help` it exports — one line for
 * the general listing, the detailed text for `gstudio help <command>` — and this class is the only place
 * that decides how either is laid out, so `gstudio` with no arguments and `gstudio help` say the same thing.
 */
export class Help {
    /** How the two views are introduced, and how the general one closes. */
    static readonly USAGE = 'Usage: gstudio <command> [...args] [--flags]'
    static readonly FOOTER = 'Run gstudio help <command> for the detailed help of one command.'
    /** What stands in for a command that exports no help. */
    static readonly UNDOCUMENTED = '(undocumented)'

    /**
     * The help the given words ask for: the whole listing when there are none, the detailed help of the
     * command they name, or the listing of the commands they are a prefix of. Throws when they name nothing.
     */
    static async of(segments: string[] = []): Promise<string> {
        if (segments.length === 0) return Help.listing(await Command.all())

        const matches = await Command.matching(segments)
        const named = matches.find((command) => command.path === segments.join(' '))

        if (named !== undefined) return Help.detail(named)
        if (matches.length > 0) return Help.listing(matches, `Commands matching ${segments.join(' ')}:`)

        throw new Error(`Unknown command: ${segments.join(' ')}\n\n${await Help.listing(await Command.all())}`)
    }

    /** Every command in one column and its short help in the next, under a heading. */
    private static async listing(commands: Command[], heading: string = 'Commands:'): Promise<string> {
        const width = Math.max(...commands.map((command) => command.path.length), 0)
        const lines: string[] = []

        for (const command of commands) {
            const help = await command.help()

            lines.push(`  ${command.path.padEnd(width)}  ${help === null ? Help.UNDOCUMENTED : help.short}`)
        }

        return [Help.USAGE, '', heading, ...lines, '', Help.FOOTER].join('\n')
    }

    /** One command's detailed help, headed by the line it is listed under. */
    private static async detail(command: Command): Promise<string> {
        const help = await command.help()

        if (help === null) return `gstudio ${command.path}\n\nThis command exports no help. Add one at ${command.file}.`

        return `gstudio ${command.path} — ${help.short}\n\n${help.long}`
    }
}
