import { Command } from './Command.class.ts'
import { Help } from './Help.class.ts'

/**
 * The command line. It reads argv and nothing else: the words that name a command are resolved by the
 * `Command` class, what is printed when none of them do comes from the `Help` class, so `gstudio` with
 * no arguments and `gstudio help` are the same text from the same place.
 */
export class CLI {
    /** Parses argv, resolves the command it names and runs it. */
    static async run(argv: string[] = process.argv.slice(2)): Promise<void> {
        const { positional, flags } = CLI.parse(argv)

        if (positional.length === 0) return console.log(await Help.of())

        const resolved = await Command.resolve(positional)

        if (resolved === null) throw new Error(`Unknown command: ${positional.join(' ')}\n\n${await Help.of()}`)

        await (await resolved.command.handler())(resolved.args, { flags })
    }

    /** Splits argv into the words that name a command and the flags that configure it. */
    private static parse(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
        const positional: string[] = []
        const flags: Record<string, string | boolean> = {}

        for (let index = 0; index < argv.length; index++) {
            const token = argv[index]!

            if (!token.startsWith('-') || token === '-' || token === '--') {
                positional.push(token)
                continue
            }

            const body = token.slice(token.startsWith('--') ? 2 : 1)
            const equals = body.indexOf('=')

            if (equals !== -1) {
                flags[body.slice(0, equals)] = body.slice(equals + 1)
                continue
            }

            const next = argv[index + 1]

            if (next !== undefined && !next.startsWith('-')) {
                flags[body] = next
                index++
            } else {
                flags[body] = true
            }
        }

        return { positional, flags }
    }
}
