// Imports
import { ClaudeCLIGenerator } from "./ClaudeCLIGenerator.class.ts";
import { SlytherGenerator } from "./SlytherGenerator.class.ts";
import { SlytherRole } from "./SlytherRole.class.ts";

export class SlytherProviders extends SlytherGenerator {
    /**
     * Every provider a role may be played by, by the name a `@role` gives it: how to make one, and what
     * keeps it from taking the options a role hands it.
     */
    private static readonly ALL: Record<string, { make: () => SlytherGenerator; problemsOf: (options: Record<string, string>) => string[] }> = {
        "claude-cli": { make: () => new ClaudeCLIGenerator(), problemsOf: (options) => ClaudeCLIGenerator.problemsOf(options) },
    };

    /** The generator of every provider asked so far, made once and kept, keyed by the name of the provider. */
    private readonly generators = new Map<string, SlytherGenerator>();

    /** The names of the providers a role may be played by. */
    static get names(): string[] {
        return Object.keys(SlytherProviders.ALL);
    }

    override async ask<T>(prompt: string, schema: object, session?: string, cast?: SlytherRole["cast"]): Promise<{ result: T; session: string }> {
        return this.of(cast).ask<T>(prompt, schema, session, cast);
    }

    override async execute(prompt: string, cwd: string, session?: string, cast?: SlytherRole["cast"]): Promise<{ text: string; session: string }> {
        return this.of(cast).execute(prompt, cwd, session, cast);
    }

    override async pinRoles(roles: Map<string, SlytherRole["binding"]>, named: string[]): Promise<Map<string, SlytherRole["binding"]>> {
        const pinned = new Map<string, Promise<Record<string, string>>>();
        const entries = await Promise.all(
            [...roles].map(async ([role, binding]) => {
                if (!named.includes(role) || !SlytherProviders.ALL[binding.provider]) {
                    return [role, binding] as const;
                }

                const key = `${binding.provider}\0${JSON.stringify(binding.options)}`;
                const options = pinned.get(key) ?? this.made(binding.provider).pin(binding.options);

                pinned.set(key, options);

                return [role, { ...binding, options: await options }] as const;
            }),
        );

        return new Map(entries);
    }

    /**
     * What keeps the work of these casts from being asked for, once per role: a role nobody plays, a
     * provider that is not one of these, or an option the provider cannot take.
     */
    override problemsWith(casts: SlytherRole["cast"][]): string[] {
        const problems: string[] = [];
        const seen = new Set<string>();

        for (const cast of casts) {
            const fingerprint = SlytherRole.fingerprintOf(cast);

            if (seen.has(fingerprint)) {
                continue;
            }

            seen.add(fingerprint);

            if (!cast.by) {
                const standard = SlytherRole.standardOf(SlytherRole.lineOf(cast.role)!);

                problems.push(
                    `Nobody plays the ${cast.role}${cast.role === standard ? "" : `, nor the ${standard} who would stand in for it`}: bind it with @role ${standard} "<provider>" (model: "<model id>"). The providers are ${SlytherProviders.names.join(", ")}.`,
                );
                continue;
            }

            const provider = SlytherProviders.ALL[cast.by.provider];

            if (!provider) {
                problems.push(`The ${cast.by.role} is played by "${cast.by.provider}", which is not a provider: the providers are ${SlytherProviders.names.join(", ")}.`);
                continue;
            }

            problems.push(...provider.problemsOf(cast.by.options).map((problem) => `The ${cast.by!.role}, played by ${cast.by!.provider}: ${problem}`));
        }

        return [...new Set(problems)];
    }

    /** The generator of the provider that plays the role of the cast, which must be one somebody plays. */
    private of(cast: SlytherRole["cast"] | undefined): SlytherGenerator {
        if (!cast?.by) {
            throw new Error(cast ? `Nobody plays the ${cast.role}, whose work was asked for.` : "The llm was asked without a role: every call names the role it is made for.");
        }

        if (!SlytherProviders.ALL[cast.by.provider]) {
            throw new Error(`The ${cast.by.role} is played by "${cast.by.provider}", which is not a provider: the providers are ${SlytherProviders.names.join(", ")}.`);
        }

        return this.made(cast.by.provider);
    }

    /** The generator of the provider, made the first time it is asked for and kept. */
    private made(provider: string): SlytherGenerator {
        const made = this.generators.get(provider) ?? SlytherProviders.ALL[provider]!.make();

        this.generators.set(provider, made);

        return made;
    }
}
