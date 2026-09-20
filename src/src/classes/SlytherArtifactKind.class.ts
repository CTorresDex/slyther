// Imports
import type { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherBuiltinOperation } from "./SlytherBuiltinOperation.class.ts";
import { SlytherParser } from "./SlytherParser.class.ts";

export class SlytherArtifactKind {
    /** The kinds a step may be. */
    private static readonly STEPS = ["llm", "deterministic"];
    /** The operations that must be verified by an evaluate operation. */
    private static readonly VERIFIED = ["create", "update"];
    /** The qualifier of an operation that runs as a plain script and never with an llm. */
    private static readonly DETERMINISTIC = "deterministic";
    /** The qualifier of a kind whose instances are not declared: they exist because something asked for them. */
    private static readonly DEMANDED = "demanded";
    /** The param only a demanded kind takes: what the artifacts that use an instance of it ask of it. */
    private static readonly DEMANDS = { name: "demands", type: "string", optional: false };
    /** The only configuration a kind or a step may declare. */
    private static readonly LANG = "lang";
    /** The param every operation takes first: the name of the instance it is run on. */
    private static readonly ID = { name: "id", type: "string", optional: false };
    /** The param only an update takes, last: what it is run to fix. */
    private static readonly ERRORS = { name: "errors", type: "string", optional: false };
    /** The operation that is run to fix an instance, and the only one the errors are given to. */
    private static readonly UPDATE = "update";
    /**
     * The operations Slyther runs itself, and the params each takes when it names none: locate says where
     * one instance is and list ranges over every one of them, so neither is handed what an instance
     * declares, and what locate was run with is what finds the instance again.
     */
    private static readonly SHAPES: Record<string, string[]> = { locate: ["id"], list: [], signature: ["id"], uses: ["id"] };
    /** The operation that makes a kind composite: it prints the declarations an instance is made of. */
    static readonly EXPAND = "expand";

    /** The warnings found while grouping the kind, in the order found. */
    readonly warnings: string[] = [];

    constructor(
        /** The `@artifact` declaration: its content is the rules of the kind. */
        readonly artifact: SlytherArtifact,
        /** Changes whenever the rules or any operation of the kind change. */
        readonly closureHash: string,
        /** Changes whenever the rules change, but not when an operation does. */
        readonly scopeHash: string,
        /** The language the kind declares, if any. */
        readonly lang: string | undefined,
        /** The shape of every instance of the kind: what its operations are run with, after the implicit id. */
        readonly params: { name: string; type: string; optional: boolean }[],
        /** The operations of the kind, in the order written, then the built-in ones. */
        readonly operations: {
            artifact: SlytherArtifact;
            closureHash: string;
            scopeHash: string;
            /** The signature the operation receives when it runs. */
            params: { name: string; type: string; optional: boolean }[];
            /** Runs as a plain script and never with an llm. */
            deterministic: boolean;
            /** Added by Slyther, not written in the script. */
            builtin: boolean;
            steps: { artifact: SlytherArtifact; closureHash: string; lang?: string }[];
        }[],
    ) {}

    /** Groups the artifacts of a parsed script into kinds, throwing when the shape of a kind is wrong. */
    static of(parsed: ParsedSlytherScript): SlytherArtifactKind[] {
        const artifacts = new Map(parsed.artifacts.map((artifact) => [artifact.name, artifact]));
        const keyOf = (artifact: SlytherArtifact): string => `${artifact.artifact}:${artifact.name}`;
        const kinds = new Map<string, SlytherArtifactKind>();

        for (const artifact of parsed.artifacts) {
            if (artifact.artifact !== "operation") {
                SlytherArtifactKind.checkQualifiers(artifact, artifact.artifact === "artifact" ? [SlytherArtifactKind.DEMANDED] : []);
            }

            if (artifact.artifact === "artifact") {
                kinds.set(
                    artifact.name,
                    new SlytherArtifactKind(
                        artifact,
                        parsed.closureHashes.get(keyOf(artifact))!,
                        parsed.scopeHashes.get(keyOf(artifact))!,
                        SlytherArtifactKind.configOf(artifact, true),
                        SlytherArtifactKind.declaredParamsOf(artifact),
                        [],
                    ),
                );
            }
        }

        for (const artifact of parsed.artifacts) {
            if (artifact.artifact === "operation") {
                const kind = kinds.get(SlytherArtifactKind.parentOf(artifact.name));

                if (!kind) {
                    throw new Error(`Operation "${artifact.name}" must be declared inside a kind.`);
                }

                SlytherArtifactKind.checkQualifiers(artifact, [SlytherArtifactKind.DETERMINISTIC]);

                kind.operations.push({
                    artifact,
                    closureHash: parsed.closureHashes.get(keyOf(artifact))!,
                    scopeHash: parsed.scopeHashes.get(keyOf(artifact))!,
                    params: kind.paramsOf(artifact),
                    deterministic: artifact.qualifiers.includes(SlytherArtifactKind.DETERMINISTIC),
                    builtin: false,
                    steps: [],
                });
            }
        }

        for (const artifact of parsed.artifacts) {
            if (SlytherArtifactKind.STEPS.includes(artifact.artifact)) {
                const parent = SlytherArtifactKind.parentOf(artifact.name);

                if (artifacts.get(parent)?.artifact === SlytherParser.RUN_KIND) {
                    continue;
                }
                const kind = kinds.get(SlytherArtifactKind.parentOf(parent));
                const operation = kind?.operations.find((candidate) => candidate.artifact.name === parent);

                if (!kind || !operation || artifacts.get(parent)?.artifact !== "operation") {
                    throw new Error(`Step "${artifact.name}" must be declared inside an operation.`);
                }

                operation.steps.push({
                    artifact,
                    closureHash: parsed.closureHashes.get(keyOf(artifact))!,
                    ...kind.langOf(artifact, parsed),
                });
            }
        }

        for (const kind of kinds.values()) {
            kind.check(parsed);
            kind.addBuiltins(parsed);
        }

        for (const artifact of parsed.artifacts) {
            kinds.get(artifact.artifact)?.checkInstance(artifact);
        }

        return [...kinds.values()];
    }

    /** The name of the kind. */
    get name(): string {
        return this.artifact.name;
    }

    /** The rules every artifact of the kind must follow, as a pointer to their file when they are a ref. */
    get rules(): string {
        return this.artifact.prose;
    }

    /** The operation of the given name, if the kind defines it. */
    operation(name: string): SlytherArtifactKind["operations"][number] | undefined {
        return this.operations.find((operation) => operation.artifact.name === `${this.name}::${name}`);
    }

    /**
     * Whether the instances of the kind are not declared but exist because something asked for them:
     * what the uses of another artifact names is an instance, and what it asks of it is its spec.
     */
    get demanded(): boolean {
        return this.artifact.qualifiers.includes(SlytherArtifactKind.DEMANDED);
    }

    /** Whether an instance of the kind has no code of its own, only the instances its expand emits. */
    get composite(): boolean {
        return this.operation(SlytherArtifactKind.EXPAND) !== undefined;
    }

    /** The names of the kinds the expand of a composite kind may emit: the ones its prose references. */
    get emits(): string[] {
        const expand = this.operation(SlytherArtifactKind.EXPAND);
        const references = [...(expand?.artifact.references ?? []), ...(expand?.steps.flatMap((step) => step.artifact.references) ?? [])];

        return [...new Set(references.filter((reference) => reference.startsWith("artifact:")).map((reference) => reference.slice("artifact:".length)))];
    }

    private check(parsed: ParsedSlytherScript): void {
        this.checkComposite();
        this.checkDemanded();
        for (const operation of this.operations) {
            if (operation.deterministic) {
                this.checkDeterministic(operation, parsed);
            } else if (operation.steps.length === 0) {
                if (operation.artifact.prose.trim().length === 0) {
                    throw new Error(`Operation "${operation.artifact.name}" has no steps.`);
                }

                this.addImplicitStep(operation, "llm", parsed);
            } else if (operation.steps.every((step) => step.artifact.artifact === "deterministic")) {
                this.warnings.push(
                    `Operation "${operation.artifact.name}" has only deterministic steps: qualify it as deterministic.`,
                );
            }
        }

        const unverified = SlytherArtifactKind.VERIFIED.filter((name) => this.operation(name));

        if (unverified.length > 0 && !this.operation("evaluate")) {
            throw new Error(
                `Kind "${this.name}" defines ${unverified.join(" and ")} but no evaluate operation to verify ${unverified.length > 1 ? "them" : "it"} with.`,
            );
        }

        const locate = this.operation("locate");

        if (this.operations.length > 0 && !locate && !this.composite) {
            throw new Error(`Kind "${this.name}" defines operations but no locate operation to find its artifacts with.`);
        }

        if (locate && !locate.deterministic) {
            throw new Error(`Operation "${locate.artifact.name}" must be deterministic.`);
        }

        if (locate && !SlytherArtifactKind.takesId(locate.params)) {
            throw new Error(`Operation "${locate.artifact.name}" must take the id first.`);
        }
    }

    /**
     * A composite kind has nothing but its expand, which must be deterministic: its instances have no
     * code to locate, create, update or evaluate, only the instances expand emits.
     */
    private checkComposite(): void {
        const expand = this.operation(SlytherArtifactKind.EXPAND);

        if (!expand) {
            return;
        }

        if (!expand.deterministic) {
            throw new Error(`Operation "${expand.artifact.name}" must be deterministic.`);
        }

        const other = this.operations.find((operation) => operation !== expand);

        if (other) {
            throw new Error(
                `Kind "${this.name}" is composite, since it defines expand, so it cannot define "${SlytherArtifactKind.shortOf(other.artifact.name)}": an instance of it has no code of its own.`,
            );
        }
    }

    /**
     * A demanded kind has instances nobody declares: they exist because the uses of another artifact
     * named them, and what it asks of them is their spec. So an instance of one must be creatable, must
     * have code of its own, must be found by its id alone, since a demand names an instance and nothing
     * else, and must never need what only a declaration could give.
     */
    private checkDemanded(): void {
        if (!this.demanded || this.operations.length === 0) {
            return;
        }

        if (this.composite) {
            throw new Error(
                `Kind "${this.name}" is demanded and composite: an instance with no code of its own can never be asked for a member.`,
            );
        }

        if (!this.operation("create")) {
            throw new Error(`Kind "${this.name}" is demanded but defines no create operation: an instance of it could never be made.`);
        }

        const locate = this.operation("locate");

        if (locate && locate.params.length > 1) {
            throw new Error(
                `Operation "${locate.artifact.name}" takes ${locate.params.map((param) => param.name).join(", ")}, but "${this.name}" is demanded: it must take the id alone, since a demand names an instance and nothing else.`,
            );
        }

        const required = this.params.find((param) => !param.optional);

        if (required) {
            throw new Error(
                `Kind "${this.name}" is demanded and declares the param "${required.name}", which is not optional: an instance nobody declares has nothing to fill it from, so every param of a demanded kind must be optional.`,
            );
        }
    }

    /**
     * A deterministic operation never runs with an llm, so an llm step is an error, and when it has no
     * steps its content is its only step, a deterministic one.
     */
    private checkDeterministic(operation: SlytherArtifactKind["operations"][number], parsed: ParsedSlytherScript): void {
        const llm = operation.steps.find((step) => step.artifact.artifact === "llm");

        if (llm) {
            throw new Error(
                `Operation "${operation.artifact.name}" is deterministic but contains the llm step "${llm.artifact.name}".`,
            );
        }

        if (operation.steps.length === 0) {
            this.addImplicitStep(operation, "deterministic", parsed);
        }
    }

    /**
     * Makes the content of an operation without steps its only step, of the given kind and named after the
     * operation, whose closure hash is the operation's, since that already covers the content.
     */
    private addImplicitStep(
        operation: SlytherArtifactKind["operations"][number],
        kind: "llm" | "deterministic",
        parsed: ParsedSlytherScript,
    ): void {
        const { artifact } = operation;
        const name = artifact.name.slice(artifact.name.lastIndexOf("::") + 2);
        const step = artifact.as(kind, `${artifact.name}::${name}`);

        operation.steps.push({ artifact: step, closureHash: operation.closureHash, ...this.langOf(step, parsed) });
    }

    /**
     * Adds every built-in operation the kind does not declare, once it is known to have operations. The
     * ones that serve the artifacts referencing an instance of the kind are only added when there is one.
     */
    private addBuiltins(parsed: ParsedSlytherScript): void {
        if (this.operations.length === 0 || this.composite) {
            return;
        }

        const referenced =
            this.demanded ||
            this.asks(parsed) ||
            parsed.artifacts.some((artifact) =>
                artifact.references.some((reference) => reference.startsWith(`${this.name}:`) && reference !== `${artifact.artifact}:${artifact.name}`),
            );

        for (const artifact of SlytherBuiltinOperation.of(this.name, referenced)) {
            if (this.operations.some((operation) => operation.artifact.name === artifact.name)) {
                continue;
            }

            const operation: SlytherArtifactKind["operations"][number] = {
                artifact,
                closureHash: artifact.hash,
                scopeHash: artifact.hash,
                params: this.paramsOf(artifact),
                deterministic: true,
                builtin: true,
                steps: [],
            };

            this.operations.push(operation);
            this.checkDeterministic(operation, parsed);
        }
    }

    /**
     * Whether an instance of the kind may ask for an instance of a demanded kind, which its rules say
     * by referencing that kind. Nothing declares what it asks for, and a reference in prose is not how
     * it is written down: only its uses can name it, so a kind that may ask is built one, as is a
     * demanded kind itself, since what is asked of it is compared with the signature it prints.
     */
    private asks(parsed: ParsedSlytherScript): boolean {
        const demanded = new Set(
            parsed.artifacts
                .filter((artifact) => artifact.artifact === "artifact" && artifact.qualifiers.includes(SlytherArtifactKind.DEMANDED))
                .map((artifact) => `artifact:${artifact.name}`),
        );

        if (demanded.size === 0) {
            return false;
        }

        const references = [
            ...this.artifact.references,
            ...this.operations.flatMap((operation) => [...operation.artifact.references, ...operation.steps.flatMap((step) => step.artifact.references)]),
        ];

        return references.some((reference) => demanded.has(reference));
    }

    /**
     * The lang of a step: its own, else the kind's, else the script's. Only a deterministic step has
     * one, and one that has none to inherit throws. An llm step declaring one throws too.
     */
    private langOf(step: SlytherArtifact, parsed: ParsedSlytherScript): { lang?: string } {
        const own = SlytherArtifactKind.configOf(step, false);

        if (step.artifact === "llm") {
            if (own !== undefined) {
                throw new Error(`Step "${step.name}" is an llm step and cannot declare a lang.`);
            }

            return {};
        }

        const lang = own ?? this.lang ?? parsed.lang;

        if (lang === undefined) {
            throw new Error(
                `Step "${step.name}" has no lang: declare it on the step, on the kind, or with @lang on the project.`,
            );
        }

        return { lang };
    }

    /**
     * The lang declared in the args of a kind or of a step, which must be its only configuration. A kind
     * declares its params before it, so a type is one of those and not configuration at all.
     */
    private static configOf(artifact: SlytherArtifact, params: boolean): string | undefined {
        let lang: string | undefined;

        for (const arg of artifact.args) {
            if (arg.kind === "type") {
                if (params) {
                    continue;
                }

                throw new Error(`Argument "${arg.name}" of "${artifact.name}" is a type, but only a kind declares params.`);
            }

            if (arg.kind === "param") {
                throw new Error(
                    `Argument "${arg.name}" of "${artifact.name}" has no value: only an operation writes a bare name, to narrow to the params of its kind.`,
                );
            }

            if (arg.name !== SlytherArtifactKind.LANG || arg.kind !== "string") {
                throw new Error(`Unknown configuration "${arg.name}" of "${artifact.name}": the only configuration is lang.`);
            }

            lang = String(arg.value);
        }

        return lang;
    }

    /** The params a kind declares: the types among its args, which are the shape of every instance of it. */
    private static declaredParamsOf(artifact: SlytherArtifact): SlytherArtifactKind["params"] {
        const params: SlytherArtifactKind["params"] = [];

        for (const arg of artifact.args) {
            if (arg.kind !== "type") {
                continue;
            }

            if (arg.name === SlytherArtifactKind.ID.name || arg.name === SlytherArtifactKind.ERRORS.name) {
                throw new Error(
                    `Kind "${artifact.name}" declares the param "${arg.name}", which every kind has already: id is the name of the instance and errors is what an update is run to fix.`,
                );
            }

            if (params.some((param) => param.name === arg.name)) {
                throw new Error(`Kind "${artifact.name}" declares the param "${arg.name}" twice.`);
            }

            params.push({ name: arg.name, type: String(arg.value), optional: arg.optional === true });
        }

        return params;
    }

    /** Every param an operation of the kind may be run with: the id, the params of the kind, and the errors an update is run to fix. */
    private available(operation: string): SlytherArtifactKind["params"] {
        return [
            { ...SlytherArtifactKind.ID },
            ...(this.demanded ? [{ ...SlytherArtifactKind.DEMANDS }] : []),
            ...this.params.map((param) => ({ ...param })),
            ...(operation === SlytherArtifactKind.UPDATE ? [{ ...SlytherArtifactKind.ERRORS }] : []),
        ];
    }

    /**
     * The params an operation runs with. It declares none of its own: written with no args it takes every
     * param of its kind, unless it is one Slyther runs itself, which keeps its shape whether it is
     * declared by hand or added as a #{SlytherBuiltinOperation}. Written with args it narrows to the ones
     * it names, in the order it names them, which is also how locate asks for more than the id.
     */
    private paramsOf(artifact: SlytherArtifact): SlytherArtifactKind["params"] {
        const name = SlytherArtifactKind.shortOf(artifact.name);
        const available = this.available(name);
        const params: SlytherArtifactKind["params"] = [];

        for (const arg of artifact.args) {
            if (arg.kind === "type") {
                throw new Error(
                    `Argument "${arg.name}" of "${artifact.name}" is a type: the params of a kind are declared on the kind, and an operation narrows to them by name.`,
                );
            }

            if (arg.kind !== "param") {
                throw new Error(`Argument "${arg.name}" of "${artifact.name}" is configuration, which only a kind or a step declares.`);
            }

            const param = available.find((candidate) => candidate.name === arg.name);

            if (!param) {
                throw new Error(
                    `Operation "${artifact.name}" takes "${arg.name}", which "${this.name}" does not declare: it takes ${available.map((candidate) => candidate.name).join(", ")}.`,
                );
            }

            if (params.some((candidate) => candidate.name === arg.name)) {
                throw new Error(`Operation "${artifact.name}" takes "${arg.name}" twice.`);
            }

            params.push(param);
        }

        if (params.length > 0) {
            return params;
        }

        const shape = SlytherArtifactKind.SHAPES[name];

        return shape ? available.filter((param) => shape.includes(param.name)) : available;
    }

    /** An instance may only give args the kind declares as params: an arg nothing reads is a typo. */
    private checkInstance(artifact: SlytherArtifact): void {
        for (const arg of artifact.args) {
            if (this.params.some((param) => param.name === arg.name)) {
                continue;
            }

            throw new Error(
                `The ${this.name} "${artifact.name}" gives the arg "${arg.name}", which ${this.name} does not declare: it takes ${
                    this.params.length > 0 ? this.params.map((param) => param.name).join(", ") : "no args"
                }.`,
            );
        }
    }

    /** Whether the first param of the operation is the id, which is how an instance is named to it. */
    private static takesId(params: SlytherArtifactKind["params"]): boolean {
        return params[0]?.name === SlytherArtifactKind.ID.name;
    }

    private static checkQualifiers(artifact: SlytherArtifact, allowed: string[]): void {
        const unknown = artifact.qualifiers.find((qualifier) => !allowed.includes(qualifier));

        if (unknown) {
            throw new Error(
                allowed.length === 0
                    ? `"${artifact.name}" cannot be qualified: only a kind may be, as demanded, and an operation, as deterministic.`
                    : `Unknown qualifier "${unknown}" of "${artifact.name}": the only qualifier of ${allowed.includes(SlytherArtifactKind.DEMANDED) ? "a kind is demanded" : "an operation is deterministic"}.`,
            );
        }
    }

    private static parentOf(name: string): string {
        const boundary = name.lastIndexOf("::");

        return boundary < 0 ? "" : name.slice(0, boundary);
    }

    private static shortOf(name: string): string {
        return name.slice(name.lastIndexOf("::") + 2);
    }
}
