// Imports

export class SlytherRole {
    /** The roles that write, from the lightest work to the most demanding: mechanical code, the code of an instance, code where design matters. */
    static readonly WRITERS = ["scribe", "engineer", "architect"];
    /** The roles that judge, from the lightest work to the most demanding: quick checks, a review against the requirements, an audit where a false pass is costly. */
    static readonly JUDGES = ["checker", "reviewer", "auditor"];
    /** The config a kind, an operation or a step names the role its work is done by with. */
    static readonly BY = "by";

    /** Who plays a role, as a `@role` line declares it: the provider asked and the options handed to it as they are. */
    declare readonly binding: { provider: string; options: Record<string, string>; file: string; line: number };
    /** The role a piece of work asks for, and who plays it: the role bound and how, or nothing when nobody does. */
    declare readonly cast: { role: string; by?: { role: string; provider: string; options: Record<string, string> } };

    /** Whether the name is one of the roles. */
    static isRole(name: string): boolean {
        return SlytherRole.lineOf(name) !== undefined;
    }

    /** Whether the role writes or judges, undefined when it is no role at all. */
    static lineOf(role: string): "write" | "judge" | undefined {
        return SlytherRole.WRITERS.includes(role) ? "write" : SlytherRole.JUDGES.includes(role) ? "judge" : undefined;
    }

    /** How demanding the work of the role is within its line: 0, 1 or 2. */
    static rankOf(role: string): number {
        return Math.max(SlytherRole.WRITERS.indexOf(role), SlytherRole.JUDGES.indexOf(role));
    }

    /** The role of the line every project must bind, which plays whatever role of it nobody else does. */
    static standardOf(line: "write" | "judge"): string {
        return line === "write" ? SlytherRole.WRITERS[1]! : SlytherRole.JUDGES[1]!;
    }

    /** The roles of the line, lightest first. */
    static rolesOf(line: "write" | "judge"): string[] {
        return line === "write" ? SlytherRole.WRITERS : SlytherRole.JUDGES;
    }

    /**
     * Who plays the role: the one bound to it, else the standard role of its line, which every project
     * binds; nobody when neither is bound.
     */
    static cast(role: string, roles: Map<string, SlytherRole["binding"]>): SlytherRole["cast"] {
        const standard = SlytherRole.standardOf(SlytherRole.lineOf(role)!);
        const bound = roles.has(role) ? role : roles.has(standard) ? standard : undefined;
        const binding = bound === undefined ? undefined : roles.get(bound)!;

        return binding ? { role, by: { role: bound!, provider: binding.provider, options: binding.options } } : { role };
    }

    /**
     * What a cast is recorded as: the role, who plays it and how, with the options in a fixed order, so two
     * casts are recorded alike exactly when the same provider is asked the same way.
     */
    static fingerprintOf(cast: SlytherRole["cast"]): string {
        if (!cast.by) {
            return `${cast.role}=nobody`;
        }

        const options = Object.keys(cast.by.options)
            .sort()
            .map((key) => `${key}=${cast.by!.options[key]}`)
            .join(",");

        return `${cast.role}=${cast.by.role}@${cast.by.provider}(${options})`;
    }

    /** How the cast is named where the build says what it waits on: the role, and who plays it when that is another. */
    static labelOf(cast: SlytherRole["cast"]): string {
        return cast.by && cast.by.role !== cast.role ? `${cast.role}, played by the ${cast.by.role}` : cast.role;
    }
}
