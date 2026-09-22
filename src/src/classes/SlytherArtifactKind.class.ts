// Imports
import { createHash } from "node:crypto";
import type { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherBuiltinOperation } from "./SlytherBuiltinOperation.class.ts";
import { SlytherParser } from "./SlytherParser.class.ts";
import { SlytherRole } from "./SlytherRole.class.ts";

export class SlytherArtifactKind {
    /** The kinds a step may be. */
    private static readonly STEPS = ["llm", "deterministic"];
    /** The operations that must be verified by an evaluate operation. */
    private static readonly VERIFIED = ["create", "update"];
    /** The qualifier of an operation that runs as a plain script and never with an llm. */
    private static readonly DETERMINISTIC = "deterministic";
    /** The qualifier of a kind whose instances are not declared: they exist because something asked for them. */
    private static readonly DEMANDED = "demanded";
    /** The qualifier of a rule that is a counterexample: code that breaks the rules it references, never checked against an instance. */
    private static readonly NEGATIVE = "negative";
    /** The kind of a rule, and of a trait: prose and rules that kinds adopt. */
    private static readonly RULE = "rule";
    private static readonly TRAIT = "trait";
    /** The operation the check of every rule is a step of. */
    private static readonly EVALUATE = "evaluate";
    /** A fenced block of code, which a negative must hold: the code that breaks a rule. */
    private static readonly FENCED = /```[^\n]*\n[\s\S]*?```/;
    /** The param only a demanded kind takes: what the artifacts that use an instance of it ask of it. */
    private static readonly DEMANDS = { name: "demands", type: "string", optional: false };
    /** The configuration a kind or a step may declare: the lang of its scripts. */
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

    /**
     * The folder a kind is built into, which is its name with the `::` of its namespace written as a
     * dot: a name no kind can hold, since a name is words joined by `::`, and one no file system reads
     * as anything but a name, which a colon is not on every one of them.
     */
    static folderOf(name: string): string {
        return name.split("::").join(".");
    }

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
        /** The role the kind declares its work is done by, if any: it reaches the work of its own line only. */
        readonly by: string | undefined,
        /** The package the kind was imported from, if it was not declared by the project itself. */
        readonly packaged: string | undefined,
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
            /** The role the operation declares its work is done by, if any: it reaches the work of its own line only. */
            by?: string;
            /** Who runs the markdown of an operation that is not deterministic: the most demanding role among its llm steps. */
            role?: string;
            /** Every step, with the role its work is done by: who writes its script, or who does what its llm step says. */
            steps: {
                artifact: SlytherArtifact;
                closureHash: string;
                lang?: string;
                role?: string;
                /** Set for the check of a rule: the rule, whoever owns it, and the negatives that break it, which its check must reject. */
                rule?: SlytherArtifactKind["rules"][number];
            }[];
        }[],
        /** Every rule an instance must follow, in the order declared and adopted, with every adoption expanded in place. */
        readonly rules: {
            artifact: SlytherArtifact;
            closureHash: string;
            /** Checked by a script rather than judged. */
            deterministic: boolean;
            /** The lang of the script, when it is deterministic. */
            lang?: string;
            /** The kind or the trait that declares the rule, if any: its prose is what the rule is read against. */
            owner?: { artifact: SlytherArtifact; scopeHash: string };
            /** Every negative that references the rule: code that breaks it, which its check must reject. */
            negatives: { artifact: SlytherArtifact; closureHash: string }[];
        }[] = [],
        /** Every trait the kind adopts, transitively, in the order adopted. */
        readonly traits: { artifact: SlytherArtifact; scopeHash: string }[] = [],
        /** Every asset the traits it adopts declare, in the order adopted: what the project must hold once the kind is declared. */
        readonly assets: SlytherArtifact[] = [],
    ) {}

    /**
     * The args an operation is run with for an instance, one per param, by the name of the param: id is
     * the name of the instance, errors is the errors it is run to fix, a param named as an arg of the
     * instance is the value of that arg, and any other is the prose of the instance, unless it is
     * optional, which the instance simply did not give. Throws when a param that is not optional gets
     * nothing.
     */
    static argsOf(
        operation: { kind: string; name: string; params: { name: string; optional: boolean }[] },
        instance: { name: string; artifact: SlytherArtifact; demands?: string },
        key: string,
        errors: string[],
    ): string[] {
        return operation.params.map((param) => {
            const arg = instance.artifact.args.find((candidate) => candidate.name === param.name);
            const value =
                param.name === "id"
                    ? instance.name
                    : param.name === "errors"
                      ? errors.join("\n")
                      : param.name === "demands" && instance.demands !== undefined
                        ? instance.demands
                        : arg !== undefined
                          ? String(arg.value)
                          : param.optional
                            ? ""
                            : instance.artifact.prose;

            if (value === "" && !param.optional && param.name !== "errors") {
                throw new Error(`${key} gives nothing for the param "${param.name}" of ${operation.kind}::${operation.name}: declare it as an arg, or write it as the prose of the instance.`);
            }

            return value;
        });
    }

    /** Groups the artifacts of a parsed script into kinds, throwing when the shape of a kind is wrong. */
    static of(parsed: ParsedSlytherScript): SlytherArtifactKind[] {
        const artifacts = new Map(parsed.artifacts.map((artifact) => [artifact.name, artifact]));
        const keyOf = (artifact: SlytherArtifact): string => `${artifact.artifact}:${artifact.name}`;
        const kinds = new Map<string, SlytherArtifactKind>();

        for (const artifact of parsed.artifacts) {
            if (artifact.artifact !== "operation") {
                SlytherArtifactKind.checkQualifiers(
                    artifact,
                    artifact.artifact === "artifact"
                        ? [SlytherArtifactKind.DEMANDED]
                        : artifact.artifact === SlytherArtifactKind.RULE
                          ? [SlytherArtifactKind.DETERMINISTIC, SlytherArtifactKind.NEGATIVE, SlytherParser.ADOPTS]
                          : [],
                );
            }

            if (artifact.artifact === "artifact") {
                kinds.set(
                    artifact.name,
                    new SlytherArtifactKind(
                        artifact,
                        parsed.closureHashes.get(keyOf(artifact))!,
                        parsed.scopeHashes.get(keyOf(artifact))!,
                        SlytherArtifactKind.configOf(artifact, true).lang,
                        SlytherArtifactKind.configOf(artifact, true).by,
                        parsed.packages.get(artifact.name),
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
                    by: SlytherArtifactKind.byOf(artifact),
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

        SlytherArtifactKind.adopt(parsed, kinds);

        for (const kind of kinds.values()) {
            kind.check(parsed);
            kind.deriveEvaluate();
            kind.addBuiltins(parsed);
            kind.cast();
        }

        for (const artifact of parsed.artifacts) {
            kinds.get(artifact.artifact)?.checkInstance(artifact);
        }

        return [...kinds.values()];
    }

    /**
     * Gives every kind its rules: the ones it declares, in the order written, with every adoption
     * expanded in place, whether of a trait, which brings every rule it declares and adopts, or of a
     * single rule. A rule is declared inside a kind, inside a trait, or outside any, to be adopted; a
     * negative references the rules it breaks and is never a rule of anything, and what an adoption
     * names must be a trait or a rule that is neither, so each of these throws.
     */
    private static adopt(parsed: ParsedSlytherScript, kinds: Map<string, SlytherArtifactKind>): void {
        const artifacts = new Map(parsed.artifacts.map((artifact) => [artifact.name, artifact]));
        const keyOf = (artifact: SlytherArtifact): string => `${artifact.artifact}:${artifact.name}`;
        const rules = parsed.artifacts.filter((artifact) => artifact.artifact === SlytherArtifactKind.RULE);
        const isNegative = (artifact: SlytherArtifact) => artifact.qualifiers.includes(SlytherArtifactKind.NEGATIVE);
        const isAdoption = (artifact: SlytherArtifact) => artifact.qualifiers.includes(SlytherParser.ADOPTS);
        const isRule = (artifact: SlytherArtifact) => artifact.artifact === SlytherArtifactKind.RULE && !isNegative(artifact) && !isAdoption(artifact);

        for (const rule of rules) {
            const parent = artifacts.get(SlytherArtifactKind.parentOf(rule.name));

            if (parent && parent.artifact !== "artifact" && parent.artifact !== SlytherArtifactKind.TRAIT && parent.artifact !== "namespace") {
                throw new Error(`Rule "${rule.name}" must be declared inside a kind or a trait, or outside any, not inside ${parent.artifact} "${parent.name}".`);
            }

            if (isNegative(rule)) {
                if (rule.qualifiers.includes(SlytherArtifactKind.DETERMINISTIC)) {
                    throw new Error(`Rule "${rule.name}" is negative, a counterexample, so it cannot be deterministic: nothing checks it.`);
                }

                if (!rule.references.some((reference) => isRule(artifacts.get(reference.slice(reference.indexOf(":") + 1))!))) {
                    throw new Error(`Rule "${rule.name}" is negative, so it must reference the rule it breaks, as #{Kind::rule}.`);
                }

                if (!rule.source && !SlytherArtifactKind.FENCED.test(rule.content)) {
                    throw new Error(`Rule "${rule.name}" is negative but holds no code: a negative is the code that breaks a rule, written in a \`\`\` block, so a check can be run against it.`);
                }
            }

            if (isAdoption(rule)) {
                const target = artifacts.get(rule.references[0]?.slice(rule.references[0].indexOf(":") + 1) ?? "");

                if (!target || (target.artifact !== SlytherArtifactKind.TRAIT && !isRule(target))) {
                    throw new Error(`"${SlytherArtifactKind.parentOf(rule.name)}" adopts "${rule.content.slice(2, -1)}", which is not a trait or a rule${target && target.artifact === SlytherArtifactKind.RULE ? ": a negative or an adoption cannot be adopted" : ""}.`);
                }
            }
        }

        for (const asset of parsed.artifacts) {
            const parent = asset.artifact === SlytherParser.ASSET ? artifacts.get(SlytherArtifactKind.parentOf(asset.name)) : undefined;

            if (parent && parent.artifact !== SlytherArtifactKind.TRAIT && parent.artifact !== "namespace") {
                throw new Error(`Asset "${asset.name}" must be declared inside a trait, or outside any, not inside ${parent.artifact} "${parent.name}".`);
            }
        }

        const childrenOf = (owner: string) => rules.filter((rule) => SlytherArtifactKind.parentOf(rule.name) === owner);
        const assetsOf = (owner: string) => parsed.artifacts.filter((asset) => asset.artifact === SlytherParser.ASSET && SlytherArtifactKind.parentOf(asset.name) === owner);
        const ownerOf = (rule: SlytherArtifact): SlytherArtifactKind["rules"][number]["owner"] => {
            const parent = artifacts.get(SlytherArtifactKind.parentOf(rule.name));

            return parent && parent.artifact !== "namespace" ? { artifact: parent, scopeHash: parsed.scopeHashes.get(keyOf(parent))! } : undefined;
        };
        const negativesOf = (rule: SlytherArtifact) =>
            rules.filter((candidate) => isNegative(candidate) && candidate.references.includes(keyOf(rule))).map((negative) => ({ artifact: negative, closureHash: parsed.closureHashes.get(keyOf(negative))! }));
        const gather = (owner: string, into: SlytherArtifactKind, seen: string[]): void => {
            for (const child of childrenOf(owner)) {
                if (isNegative(child)) {
                    continue;
                }

                const target = isAdoption(child) ? artifacts.get(child.references[0]!.slice(child.references[0]!.indexOf(":") + 1))! : child;

                if (target.artifact === SlytherArtifactKind.TRAIT) {
                    if (seen.includes(target.name)) {
                        throw new Error(`Trait "${target.name}" adopts itself: ${[...seen, target.name].join(" adopts ")}.`);
                    }

                    into.traits.push({ artifact: target, scopeHash: parsed.scopeHashes.get(keyOf(target))! });
                    into.assets.push(...assetsOf(target.name));
                    gather(target.name, into, [...seen, target.name]);
                    continue;
                }

                into.rules.push({
                    artifact: target,
                    closureHash: parsed.closureHashes.get(keyOf(target))!,
                    deterministic: target.qualifiers.includes(SlytherArtifactKind.DETERMINISTIC),
                    owner: ownerOf(target),
                    negatives: negativesOf(target),
                });
            }
        };

        for (const kind of kinds.values()) {
            gather(kind.name, kind, [kind.name]);

            for (const rule of kind.rules) {
                if (rule.deterministic) {
                    rule.lang = kind.langOf(rule.artifact.as("deterministic", rule.artifact.name, rule.artifact.args), parsed).lang;
                }
            }
        }

    }

    /**
     * Makes the check of every rule a step of evaluate, before whatever steps it declares, adding the
     * operation when the kind declares none. A deterministic rule is a deterministic step and any other
     * an llm step, so an evaluate that gains an llm rule is deterministic no more: the qualifier only
     * says what its own steps are.
     */
    private deriveEvaluate(): void {
        if (this.rules.length === 0 || this.composite) {
            return;
        }

        let evaluate = this.operation(SlytherArtifactKind.EVALUATE);

        if (!evaluate) {
            const artifact = new SlytherArtifact("operation", `${this.name}::${SlytherArtifactKind.EVALUATE}`, [], [SlytherArtifactKind.DETERMINISTIC], "", []);

            evaluate = { artifact, closureHash: artifact.hash, scopeHash: artifact.hash, params: this.paramsOf(artifact), deterministic: true, builtin: false, steps: [] };
            this.operations.push(evaluate);
        }

        const checks = this.rules.map((rule) => {
            const kind = rule.deterministic ? "deterministic" : "llm";
            const step = rule.artifact.as(kind, `${this.name}::${SlytherArtifactKind.EVALUATE}::${SlytherArtifactKind.folderOf(rule.artifact.name)}`, rule.artifact.args);

            return { artifact: step, closureHash: rule.closureHash, ...(rule.deterministic ? { lang: rule.lang } : {}), rule };
        });

        evaluate.steps.unshift(...checks);
        evaluate.deterministic = evaluate.deterministic && this.rules.every((rule) => rule.deterministic);
    }

    /** The prose of the kind outside its rules: what a writer is told and nothing checks. */
    get guidance(): string {
        return this.artifact.prose;
    }

    /**
     * The hash of what the kind says outside its rules: its scope hash and the scope hash of every trait
     * it adopts, and its scope hash alone when it adopts none.
     */
    get guidanceHash(): string {
        return this.traits.length === 0 ? this.scopeHash : SlytherArtifactKind.hash(this.scopeHash, ...this.traits.map((trait) => trait.scopeHash));
    }

    /** The hash of everything a writer of an instance is shown: the guidance, every rule and every negative, and the guidance hash alone without rules. */
    get rulesHash(): string {
        if (this.rules.length === 0) {
            return this.guidanceHash;
        }

        return SlytherArtifactKind.hash(
            this.guidanceHash,
            ...this.rules.map((rule) => rule.closureHash),
            ...this.rules.flatMap((rule) => rule.negatives.map((negative) => negative.closureHash)),
        );
    }

    /**
     * The rules every artifact of the kind must follow, as a writer is shown them: the guidance, then
     * every rule under its name, saying whether a script or a judge checks it, the prose of every trait
     * before the rules it brings, and every negative as what never to write. With a folder, the prose
     * of a ref is read into it; without one, it points at its file.
     */
    rulesOf(cwd?: string): string {
        const text = (artifact: SlytherArtifact) => (cwd === undefined ? artifact.prose : artifact.textIn(cwd));
        const lines = [text(this.artifact)];
        const shown = new Set<string>();
        let owner: string | undefined;

        for (const rule of this.rules) {
            if (rule.owner?.artifact.artifact === SlytherArtifactKind.TRAIT && rule.owner.artifact.name !== owner) {
                owner = rule.owner.artifact.name;
                lines.push("", `### Trait ${owner}`, "", text(rule.owner.artifact) || "(no further description)");
            }

            lines.push("", `### Rule ${rule.artifact.name} (${rule.deterministic ? "checked by a script" : "judged"})`, "", text(rule.artifact));

            for (const negative of rule.negatives) {
                if (!shown.has(negative.artifact.name)) {
                    shown.add(negative.artifact.name);
                    lines.push("", `#### Never, as ${negative.artifact.name}`, "", text(negative.artifact));
                }
            }
        }

        return lines.join("\n").trim();
    }

    private static hash(...parts: string[]): string {
        return createHash("sha256").update(parts.join("\n")).digest("hex");
    }

    /** The name of the kind. */
    get name(): string {
        return this.artifact.name;
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
            } else if (
                operation.steps.every((step) => step.artifact.artifact === "deterministic") &&
                !(SlytherArtifactKind.shortOf(operation.artifact.name) === SlytherArtifactKind.EVALUATE && this.rules.some((rule) => !rule.deterministic))
            ) {
                this.warnings.push(
                    `Operation "${operation.artifact.name}" has only deterministic steps: qualify it as deterministic.`,
                );
            }
        }

        const unverified = SlytherArtifactKind.VERIFIED.filter((name) => this.operation(name));

        if (unverified.length > 0 && !this.operation(SlytherArtifactKind.EVALUATE) && this.rules.length === 0) {
            throw new Error(
                `Kind "${this.name}" defines ${unverified.join(" and ")} but no rules and no evaluate operation to verify ${unverified.length > 1 ? "them" : "it"} with.`,
            );
        }

        const locate = this.operation("locate");

        if ((this.operations.length > 0 || this.rules.length > 0) && !locate && !this.composite) {
            throw new Error(`Kind "${this.name}" defines ${this.operations.length > 0 ? "operations" : "rules"} but no locate operation to find its artifacts with.`);
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

        if (this.rules.length > 0) {
            throw new Error(`Kind "${this.name}" is composite, since it defines expand, so it cannot have rules: an instance of it has no code of its own to check.`);
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
            ...this.rules.flatMap((rule) => rule.artifact.references),
            ...this.operations.flatMap((operation) => [...operation.artifact.references, ...operation.steps.flatMap((step) => step.artifact.references)]),
        ];

        return references.some((reference) => demanded.has(reference));
    }

    /**
     * The lang of a step: its own, else the kind's, else the script's. Only a deterministic step has
     * one, and one that has none to inherit throws. An llm step declaring one throws too.
     *
     * The script is only the last word for a kind the project declares itself: the `@lang` of whoever
     * imports a package says nothing about the scripts of a kind that package ships, whose rules were
     * written against a language of their own, so a packaged kind must declare it.
     */
    private langOf(step: SlytherArtifact, parsed: ParsedSlytherScript): { lang?: string } {
        const own = SlytherArtifactKind.configOf(step, false).lang;

        if (step.artifact === "llm") {
            if (own !== undefined) {
                throw new Error(`Step "${step.name}" is an llm step and cannot declare a lang.`);
            }

            return {};
        }

        const lang = own ?? this.lang ?? (this.packaged === undefined ? parsed.lang : undefined);

        if (lang === undefined) {
            throw new Error(
                this.packaged === undefined
                    ? `Step "${step.name}" has no lang: declare it on the step, on the kind, or with @lang on the project.`
                    : `Step "${step.name}" has no lang: the kind "${this.name}" comes from the package "${this.packaged}", so it must declare it on the step or on the kind, since the @lang of the project does not reach a package.`,
            );
        }

        return { lang };
    }

    /**
     * Gives every step the role its work is done by, and every operation that is not deterministic the
     * role that runs its markdown, once every step is known. A deterministic step is work that writes,
     * its script; an llm step judges in evaluate and writes anywhere else. Its own `by` decides, and
     * must be of the line of its work. A script is mechanical whatever it serves, so it is written by the
     * scribe unless its own step says otherwise; an llm step takes the `by` of its operation, then of its
     * kind, whichever is of its line, else the standard role of that line.
     * The markdown of an operation runs in a single session, so it is played by the most demanding role
     * any of its llm steps asks for.
     */
    private cast(): void {
        for (const operation of this.operations) {
            const judges = SlytherArtifactKind.shortOf(operation.artifact.name) === "evaluate";

            for (const step of operation.steps) {
                const script = step.artifact.artifact === "deterministic";
                const line = !script && judges ? "judge" : "write";
                const own = SlytherArtifactKind.configOf(step.artifact, false).by;

                if (own !== undefined && SlytherRole.lineOf(own) !== line) {
                    throw new Error(
                        `Step "${step.artifact.name}" is done by the ${own}, who ${SlytherRole.lineOf(own) === "judge" ? "judges" : "writes"}, but its work is to ${script ? "be written as a script" : line === "judge" ? "judge" : "write"}: it takes one of ${SlytherRole.rolesOf(line).join(", ")}.`,
                    );
                }

                const inherited = script ? undefined : [operation.by, this.by].find((by) => by !== undefined && SlytherRole.lineOf(by) === line);

                step.role = own ?? inherited ?? (script ? SlytherRole.WRITERS[0]! : SlytherRole.standardOf(line));
            }

            const llm = operation.steps.filter((step) => step.artifact.artifact === "llm").map((step) => step.role!);

            if (!operation.deterministic && llm.length > 0) {
                operation.role = llm.reduce((most, role) => (SlytherRole.rankOf(role) > SlytherRole.rankOf(most) ? role : most));
            }
        }
    }

    /**
     * The configuration declared in the args of a kind or of a step: the lang of its scripts and the role
     * its work is done by. A kind declares its params before it, so a type is one of those and not
     * configuration at all.
     */
    private static configOf(artifact: SlytherArtifact, params: boolean): { lang?: string; by?: string } {
        const config: { lang?: string; by?: string } = {};

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

            if (arg.kind === "string" && arg.name === SlytherRole.BY) {
                config.by = SlytherArtifactKind.roleIn(artifact, String(arg.value));
                continue;
            }

            if (arg.name !== SlytherArtifactKind.LANG || arg.kind !== "string") {
                throw new Error(`Unknown configuration "${arg.name}" of "${artifact.name}": the configuration is lang and by.`);
            }

            config.lang = String(arg.value);
        }

        return config;
    }

    /** The role an operation declares its work is done by, among the params it narrows to. */
    private static byOf(artifact: SlytherArtifact): string | undefined {
        const by = artifact.args.find((arg) => arg.kind === "string" && arg.name === SlytherRole.BY);

        return by === undefined ? undefined : SlytherArtifactKind.roleIn(artifact, String(by.value));
    }

    /** The role a `by` names, which must be one of the roles. */
    private static roleIn(artifact: SlytherArtifact, role: string): string {
        if (!SlytherRole.isRole(role)) {
            throw new Error(
                `"${artifact.name}" is done by "${role}", which is not a role: the roles that write are ${SlytherRole.WRITERS.join(", ")}, and the ones that judge are ${SlytherRole.JUDGES.join(", ")}.`,
            );
        }

        return role;
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

            if (arg.name === SlytherRole.BY) {
                throw new Error(`Kind "${artifact.name}" declares the param "${SlytherRole.BY}", which names the role its work is done by: name the param otherwise.`);
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

            if (arg.kind === "string" && arg.name === SlytherRole.BY) {
                continue;
            }

            if (arg.kind !== "param") {
                throw new Error(`Argument "${arg.name}" of "${artifact.name}" is configuration, which only a kind or a step declares, save the by of an operation.`);
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
                    ? `"${artifact.name}" cannot be qualified: only a kind may be, as demanded, an operation, as deterministic, and a rule, as deterministic or negative.`
                    : `Unknown qualifier "${unknown}" of "${artifact.name}": the only qualifier${allowed.includes(SlytherArtifactKind.NEGATIVE) ? "s of a rule are deterministic and negative" : ` of ${allowed.includes(SlytherArtifactKind.DEMANDED) ? "a kind is demanded" : "an operation is deterministic"}`}.`,
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
