// Imports
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProcessUtils } from "./ProcessUtils.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";
import type { SlytherArtifactManifest } from "./SlytherArtifactManifest.class.ts";
import { SlytherArtifactKind } from "./SlytherArtifactKind.class.ts";
import { SlytherExpansion } from "./SlytherExpansion.class.ts";
import type { SlytherGenerator } from "./SlytherGenerator.class.ts";
import { SlytherInstanceManifest } from "./SlytherInstanceManifest.class.ts";
import { StringUtils } from "./StringUtils.class.ts";
import type { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";

export class SlytherInstanceChecker {
    /** The folder, next to the manifest, where what every instance of a composite kind emitted is written. */
    static readonly EXPANDED = "expanded";
    /** The folder, next to the manifest, where what is asked of every instance of a demanded kind is written. */
    static readonly DEMANDED = "demanded";
    /** How deep an instance may ask for another that does not exist yet before the chain is given up on. */
    private static readonly ROUNDS = 3;
    /** How long a script of an operation gets to finish before it is killed, with everything it spawned, and counted as a failure. */
    private static readonly TIMEOUT = 60_000;
    /** What an llm step of evaluate must reply. */
    private static readonly VERDICT = {
        type: "object",
        properties: { pass: { type: "boolean" }, errors: { type: "array", items: { type: "string" } } },
        required: ["pass", "errors"],
    };
    /** `path`, `path:start-end` or `path:line`, which is the range of that one line: a segment locate prints. */
    private static readonly SEGMENT = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/;
    /** How the reason of an instance that uses a key that is gone ends. */
    private static readonly GONE = ", which no longer exists";
    /** The reason of an instance whose declaration changed, so it is updated rather than evaluated. */
    private static readonly SPEC = "its spec changed";
    /** The reason of an instance whose kind changed its rules, so every instance of it is updated. */
    private static readonly RULES = "the rules of its kind changed";
    /** The reason of an instance with code that has no record yet, which is evaluated before anything touches it. */
    private static readonly NEW = "never evaluated";

    private manifest!: SlytherInstanceManifest;
    /** Every artifact of the script being checked, expanded, keyed by `kind:name`. */
    private declared = new Map<string, SlytherArtifact>();
    /** What every instance with code looks like now, keyed by `kind:name`. */
    private states = new Map<string, SlytherInstanceChecker["state"]>();

    constructor(
        /** The folder the code of the project lives in, where every script runs. */
        private readonly cwd: string,
        /** The folder the operations are built into, relative to where the scripts run. */
        private readonly artifacts: string,
        /** Where the instances manifest is written. */
        private readonly path: string,
        private readonly built: SlytherArtifactManifest,
        private readonly generator: SlytherGenerator,
        /** compile: create and update; max: llm budget; log: prints a finished line; say: names what is being waited on. */
        private readonly options: { compile?: boolean; max?: number; log?: (line: string) => void; say?: (label: string) => void } = {},
    ) {}

    /**
     * Checks every instance declared in the script whose kind has operations: locates it, decides
     * whether it must be evaluated again, from its own spec, its own code, the scripts it is evaluated
     * with and what it uses of the instances it references, evaluates it when it must, in an order where
     * every instance comes after the ones it references, and records the outcome.
     *
     * With compile, it is a compiler: an instance that is missing is created with the create operation
     * of its kind, one whose spec changed is updated with its update operation, and one that fails
     * evaluation, or failed last time, is updated with the errors and evaluated once more. Without it,
     * nothing touches the code. Returns what happened to every instance.
     */
    async check(parsed: ParsedSlytherScript, kinds: SlytherArtifactKind[]): Promise<SlytherInstanceChecker["entry"][]> {
        this.manifest = await SlytherInstanceManifest.load(this.path);

        const { parsed: expanded, expansions } = await this.expand(parsed, kinds);

        this.declared = new Map(expanded.artifacts.map((artifact) => [`${artifact.artifact}:${artifact.name}`, artifact]));

        const instances = this.instancesOf(expanded, kinds, expansions);
        const report: SlytherInstanceChecker["entry"][] = [];

        await this.migrate(instances);

        for (const [key, expansion] of expansions) {
            const instance = instances.get(key)!;

            this.manifest.instances[key] = {
                ...SlytherInstanceChecker.emptyRecord(),
                specHash: this.specHashOf(instance),
                rulesHash: instance.rules,
                spec: this.specTextOf(instance),
                rules: instance.rulesText,
                evaluatedWith: this.evaluatedWithOf(instance.kind),
                result: expansion.error ? "fail" : "pass",
                errors: expansion.error ? [expansion.error] : [],
            };
            report.push(
                expansion.error
                    ? { key, status: "fail", reason: "what it emitted is not valid", errors: [expansion.error] }
                    : { key, status: "expanded", reason: `emitted ${expansion.emitted.length} instance${expansion.emitted.length === 1 ? "" : "s"}`, errors: [] },
            );
        }

        const coded = new Map([...instances].filter(([, instance]) => !instance.composite));
        const states = new Map<string, SlytherInstanceChecker["state"]>();

        this.states = states;

        for (const [key, instance] of coded) {
            this.options.say?.(`${key}: locating`);
            report.push(...(await this.moved(key, instance)));
            states.set(key, await this.stateOf(key, instance));
        }

        // What the code already written asks for, so an instance nothing declares is checked as any other.
        await this.demand(coded, states, kinds);

        for (const key of Object.keys(this.manifest.instances)) {
            if (!instances.has(key) && !coded.has(key)) {
                report.push(...(await this.forget(key)));
            }
        }

        await this.warnUndeclared(kinds, instances);

        const order = SlytherInstanceChecker.orderOf(coded);
        /** Every instance put off because what it asks for did not exist yet: how often, and what was done to it before. */
        const deferred = new Map<string, { rounds: number; done: SlytherInstanceChecker["entry"]["status"]; reason: string }>();
        const pending = order.filter((key) => this.workOf(key, coded.get(key)!, states) !== null);
        const llm = pending.filter((key) => this.needsLlm(coded.get(key)!.kind, this.workOf(key, coded.get(key)!, states)!)).length;

        if (this.options.max !== undefined && llm > this.options.max) {
            throw new Error(`${llm} instances need the llm, more than the ${this.options.max} allowed: raise --max or narrow the change.`);
        }

        if (pending.length > 0) {
            this.options.log?.(`${pending.length} of ${coded.size} instances need work, ${llm} with the llm`);
        }

        for (const key of order) {
            const instance = coded.get(key)!;
            let state = states.get(key)!;
            const work = this.workOf(key, instance, states);
            const parent = instance.parent ? { parent: instance.parent } : {};
            /** What the manifest records of who the instance belongs to: the parent that emitted it, or what asks for it. */
            const owner = {
                ...parent,
                ...(instance.demandedBy ? { demandedBy: instance.demandedBy } : {}),
                ...(instance.demands !== undefined ? { demands: instance.demands } : {}),
            };

            if (work === null) {
                const record = this.manifest.instances[key];

                if (state.segments === undefined) {
                    this.manifest.instances[key] = {
                        ...SlytherInstanceChecker.emptyRecord(),
                        specHash: this.specHashOf(instance),
                        rulesHash: instance.rules,
                        spec: this.specTextOf(instance),
                        rules: instance.rulesText,
                        ...owner,
                    };
                    report.push({ key, status: "missing", errors: [], ...parent });
                } else if (record?.result === "fail") {
                    report.push({ key, status: "fail", reason: "unchanged since it failed", errors: record.errors, ...parent });
                } else {
                    report.push({ key, status: "kept", errors: [], ...parent });
                }

                continue;
            }

            const started = Date.now();

            let verdict: { pass: boolean; errors: string[] };
            let status: SlytherInstanceChecker["entry"]["status"];

            if (work.operation) {
                await this.perform(work.operation, instance, key, [], work.reason);
                state = await this.relocate(key, instance, states);

                // What it turned out to ask for is only known now: whatever is missing is made before it is judged.
                const asked = await this.demand(coded, states, kinds);
                const put = deferred.get(key);
                const rounds = put?.rounds ?? 0;

                if (asked.length > 0 && rounds < SlytherInstanceChecker.ROUNDS) {
                    deferred.set(key, { rounds: rounds + 1, done: put?.done ?? work.done, reason: put?.reason ?? work.reason });
                    order.push(...asked, key);
                    this.options.log?.(`${key}: asks for ${asked.join(", ")}, which nothing has made yet`);

                    continue;
                }

                verdict =
                    state.segments === undefined
                        ? { pass: false, errors: [work.operation === "create" ? "the create did not produce it" : "the update removed it"] }
                        : await this.evaluate(instance, key, state);
            } else {
                verdict = work.broken ? { pass: false, errors: [work.reason] } : await this.evaluate(instance, key, state);
            }

            // An instance put off until what it asked for existed is reported as what was done to it, not as merely evaluated.
            const put = deferred.get(key);
            const done = put?.done ?? work.done;
            const reason = put?.reason ?? work.reason;

            status = verdict.pass ? done : "fail";

            if (!verdict.pass && this.options.compile && state.segments !== undefined && this.has(instance.kind, "update")) {
                this.options.log?.(`${key}: failed evaluation, updating to fix:\n${verdict.errors.map((error) => `    - ${error}`).join("\n")}`);
                await this.perform("update", instance, key, verdict.errors, work.reason);
                state = await this.relocate(key, instance, states);
                verdict = state.segments === undefined ? { pass: false, errors: ["the update removed it"] } : await this.evaluate(instance, key, state);
                status = verdict.pass ? (done === "pass" ? "fixed" : done) : "fail";
            }

            // Without compile, a spec or a rule that changed is not recorded as seen, so a later build still updates it.
            const seen = this.options.compile || !this.manifest.instances[key];

            this.manifest.instances[key] = {
                specHash: seen ? this.specHashOf(instance) : this.manifest.instances[key]!.specHash,
                rulesHash: seen ? instance.rules : (this.manifest.instances[key]!.rulesHash ?? instance.rules),
                spec: seen ? this.specTextOf(instance) : this.manifest.instances[key]!.spec,
                rules: seen ? instance.rulesText : this.manifest.instances[key]!.rules,
                ...owner,
                ...(state.locatedWith ? { locatedWith: state.locatedWith } : {}),
                contentHash: state.contentHash ?? "",
                ...(state.signature ? { signature: state.signature } : {}),
                dependencies: Object.fromEntries(
                    instance.references.map((reference) => {
                        const dependency = states.get(reference)!;

                        return [reference, { contentHash: dependency.contentHash ?? "", ...(dependency.signature ? { signature: dependency.signature } : {}) }];
                    }),
                ),
                evaluatedWith: this.evaluatedWithOf(instance.kind),
                result: verdict.pass ? "pass" : "fail",
                errors: verdict.errors,
            };
            await this.manifest.save();
            this.options.log?.(`${status} ${key}: ${reason} (${StringUtils.duration(Date.now() - started)})`);
            report.push({ key, status, reason, errors: verdict.errors, ...parent });
        }

        await this.reap(coded, states, kinds, report);
        await this.writeDemanded(coded);
        await this.manifest.save();

        return SlytherInstanceChecker.grouped(report);
    }

    /**
     * Brings a manifest written before the rules of a kind, or the text of a declaration, were recorded
     * forward: every instance is taken to have been brought in line with the rules and the prose as they
     * are now, so what it already complies with is not updated again, only a change made from here on is
     * noticed, and the first update of an instance carries no diff rather than one against nothing.
     */
    private async migrate(instances: Map<string, SlytherInstanceChecker["instance"]>): Promise<void> {
        if (this.manifest.version >= SlytherInstanceManifest.VERSION) {
            return;
        }

        for (const [key, record] of Object.entries(this.manifest.instances)) {
            const instance = instances.get(key);

            if (this.manifest.version < 2) {
                record.rulesHash = instance?.rules ?? "";
            }

            record.spec = instance ? this.specTextOf(instance) : "";
            record.rules = instance?.rulesText ?? "";
        }

        await this.manifest.save();
        this.options.log?.(`brought the instances manifest forward to version ${SlytherInstanceManifest.VERSION}`);
    }

    /**
     * Runs the expand of every instance of a composite kind, in the order declared, and reads what it
     * prints into the script, so the instances it emits are checked as any other. What it prints is
     * written next to the manifest, one file per instance, and what is not valid fails the instance
     * and emits nothing. Returns the script expanded and, per instance, what it emitted or why it failed.
     */
    private async expand(
        parsed: ParsedSlytherScript,
        kinds: SlytherArtifactKind[],
    ): Promise<{ parsed: ParsedSlytherScript; expansions: Map<string, { emitted: string[]; error?: string }> }> {
        const composite = new Set(kinds.filter((kind) => kind.composite).map((kind) => kind.name));
        const expansions = new Map<string, { emitted: string[]; error?: string }>();
        const written = new Set<string>();
        let expanded = parsed;

        for (const artifact of parsed.artifacts) {
            if (!composite.has(artifact.artifact)) {
                continue;
            }

            const key = `${artifact.artifact}:${artifact.name}`;

            try {
                const printed = await this.runExpand(key, { kind: artifact.artifact, name: artifact.name, artifact });
                const result = SlytherExpansion.of(printed, artifact, kinds, expanded);
                const path = this.expandedPathOf(artifact.artifact, artifact.name);

                expanded = result.parsed;
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, `${printed.trim()}\n`);
                written.add(path);
                expansions.set(key, { emitted: result.emitted });
            } catch (error) {
                expansions.set(key, { emitted: [], error: error instanceof Error ? error.message : String(error) });
            }
        }

        await SlytherInstanceChecker.prune(join(dirname(this.path), SlytherInstanceChecker.EXPANDED), written);

        return { parsed: expanded, expansions };
    }

    /** What the expand of the instance prints, with its params filled as create fills them. Throws when it is not built or fails. */
    private async runExpand(key: string, instance: { kind: string; name: string; artifact: SlytherArtifact }): Promise<string> {
        const operation = this.built.operations[`${instance.kind}::${SlytherArtifactKind.EXPAND}`];

        if (!operation?.deterministic) {
            throw new Error(`the expand of ${instance.kind} is not built: run build first.`);
        }

        const args = SlytherInstanceChecker.argsOf(operation, instance, key, []);
        let printed = "";

        for (const step of operation.steps) {
            this.options.say?.(`${key}: expanding with ${step.run!.join(" ")}`);

            const result = await ProcessUtils.run([...step.run!, ...args], { cwd: this.cwd, timeout: SlytherInstanceChecker.TIMEOUT });

            if (result.code !== 0) {
                throw new Error(`expanding ${key} failed:\n${result.stderr || result.stdout}`);
            }

            printed = result.stdout;
        }

        return printed;
    }

    /** Where what an instance of a composite kind emitted is written. */
    private expandedPathOf(kind: string, name: string): string {
        return join(dirname(this.path), SlytherInstanceChecker.EXPANDED, kind, `${name}.sly`);
    }

    /** Removes what was written, under the folder, for instances that are gone, and the folders left empty. */
    private static async prune(folder: string, written: Set<string>): Promise<void> {
        const kinds = await readdir(folder, { withFileTypes: true }).catch(() => []);

        for (const kind of kinds) {
            if (!kind.isDirectory()) {
                continue;
            }

            for (const file of await readdir(join(folder, kind.name))) {
                if (!written.has(join(folder, kind.name, file))) {
                    await rm(join(folder, kind.name, file), { force: true });
                }
            }

            if ((await readdir(join(folder, kind.name))).length === 0) {
                await rmdir(join(folder, kind.name));
            }
        }
    }

    /**
     * Drops the record of an instance that is no longer declared, unless a parent emitted it, or
     * something demanded it, and its code is still there: then it is an orphan, reported and kept out
     * of the graph until its code is gone. A demanded instance is an orphan once nothing asks for it
     * at all, never because one of the artifacts that used it stopped.
     */
    private async forget(key: string): Promise<SlytherInstanceChecker["entry"][]> {
        const record = this.manifest.instances[key]!;
        const boundary = key.indexOf(":");
        const owned = record.parent !== undefined || record.demandedBy !== undefined;
        const located = owned ? await this.runOperation(key.slice(0, boundary), "locate", record.locatedWith ?? [key.slice(boundary + 1)]) : undefined;

        if (located?.code !== 0) {
            delete this.manifest.instances[key];

            return [];
        }

        record.result = "orphan";
        record.errors = [];

        return [
            {
                key,
                status: "orphan",
                reason: record.parent ? `no longer emitted by ${record.parent}` : "nothing asks for it any more",
                errors: [],
                ...(record.parent ? { parent: record.parent } : {}),
            },
        ];
    }

    /**
     * The code an instance left behind when its args moved it: locate ran with other args when it was
     * checked, so it is run with them once more, and whatever it still finds is reported as an orphan
     * and left alone, since nothing removes code. It is reported once, the check that notices the move.
     */
    private async moved(key: string, instance: { kind: string; name: string; artifact: SlytherArtifact }): Promise<SlytherInstanceChecker["entry"][]> {
        const before = this.manifest.instances[key]?.locatedWith;

        if (!before) {
            return [];
        }

        const now = this.argsFor(instance.kind, "locate", instance, key);

        if (before.join("\n") === now.join("\n")) {
            return [];
        }

        const located = await this.runOperation(instance.kind, "locate", before);

        if (!located || located.code !== 0) {
            return [];
        }

        const segments = SlytherInstanceChecker.linesOf(located.stdout);

        return [{ key, status: "orphan", reason: `moved, so its code is left at ${segments.join(", ")}`, errors: [] }];
    }

    /** The report with every emitted instance right after its parent, its orphans after them, and the orphans of a parent that is gone last. */
    private static grouped(report: SlytherInstanceChecker["entry"][]): SlytherInstanceChecker["entry"][] {
        const parents = report.filter((entry) => !entry.parent);
        const childrenOf = (parent: string) => report.filter((entry) => entry.parent === parent);
        const grouped = parents.flatMap((parent) => [
            parent,
            ...childrenOf(parent.key).filter((entry) => entry.status !== "orphan"),
            ...childrenOf(parent.key).filter((entry) => entry.status === "orphan"),
        ]);

        return [...grouped, ...report.filter((entry) => entry.parent && !parents.some((parent) => parent.key === entry.parent))];
    }

    /**
     * The hash of the declaration of the instance and of everything it leans on: what it references
     * that has no code of its own, so a change to the rules of a kind or the prose of a plain artifact
     * or of a parent counts as a change of its spec. Just its own hash when it leans on nothing.
     */
    private specHashOf(instance: { artifact: SlytherArtifact; leans: string[]; demands?: string }): string {
        const parts = [
            ...(instance.demands === undefined ? [] : [`demands\n${instance.demands}`]),
            ...instance.leans.map((reference) => `${reference}@${this.declared.get(reference)?.hash ?? ""}`),
        ];

        return parts.length === 0 ? instance.artifact.hash : SlytherInstanceChecker.hash(instance.artifact.hash, ...parts);
    }

    /**
     * The declaration of the instance and of everything it leans on as text: what the spec hash covers,
     * written out, so what an update is brought in line with can be diffed against what it was last
     * brought in line with.
     */
    private specTextOf(instance: { artifact: SlytherArtifact; leans: string[]; demands?: string }): string {
        const leans = instance.leans.map((reference) => {
            const artifact = this.declared.get(reference);

            return artifact
                ? `(leans on ${artifact.artifact} ${artifact.name})\n${SlytherInstanceChecker.specOf(artifact)}`
                : `(leans on ${reference}, which is not declared)`;
        });

        return [SlytherInstanceChecker.mustOf(instance), ...leans].join("\n\n");
    }

    /**
     * What the instance references, for the generator to read, one level deep: the rules of a kind, the
     * prose of a plain artifact, and the args, the prose and the signature of an instance.
     */
    private contextOf(instance: { kind: string; name: string; artifact: SlytherArtifact }, heading: string): string[] {
        const sections: string[] = [];

        for (const reference of instance.artifact.references) {
            const artifact = this.declared.get(reference);

            if (!artifact || reference === `${instance.kind}:${instance.name}`) {
                continue;
            }

            if (artifact.artifact === "artifact") {
                sections.push(`${heading} The rules of every ${artifact.name}`, "", artifact.prose || "(no rules)", "");
                continue;
            }

            const signature = this.states.get(reference)?.signature;

            sections.push(
                `${heading} ${artifact.artifact} ${artifact.name}`,
                "",
                SlytherInstanceChecker.specOf(artifact),
                ...(signature ? ["", "Signature:", "", ...signature.map((line) => `- ${line}`)] : []),
                "",
            );
        }

        return sections;
    }

    /**
     * What an instance needs: why, the operation to run before evaluating it, if any, what to report
     * when it passes, and whether it is certainly broken. Null when nothing is to be done: it is up to
     * date, or it is missing and cannot be created.
     *
     * The prose binds the code, and the evaluate of a kind only ever covers part of what the prose
     * says, so anything that changed is brought in line with the update of its kind before it is
     * evaluated, rather than trusting an evaluate that passes to mean it still complies. The two that
     * are not brought in line are an instance with no record yet, which has changed from nothing and is
     * evaluated as it stands, and one that references a key that is gone, which no update can fix.
     */
    private workOf(
        key: string,
        instance: { kind: string; artifact: SlytherArtifact; leans: string[]; rules: string; demands?: string },
        states: Map<string, SlytherInstanceChecker["state"]>,
    ): { reason: string; operation?: "create" | "update"; done: "created" | "updated" | "pass"; broken: boolean } | null {
        const state = states.get(key)!;

        if (state.invalid !== undefined) {
            return { reason: state.invalid, done: "pass", broken: true };
        }

        if (state.segments === undefined) {
            return this.options.compile && this.has(instance.kind, "create") ? { reason: "missing", operation: "create", done: "created", broken: false } : null;
        }

        const reason = this.changeOf(key, instance, state, states);

        if (reason === null) {
            return null;
        }

        const broken = reason.endsWith(SlytherInstanceChecker.GONE);
        const brings = reason !== SlytherInstanceChecker.NEW && !broken;

        if (brings && this.options.compile && this.has(instance.kind, "update")) {
            return { reason, operation: "update", done: "updated", broken: false };
        }

        return { reason, done: "pass", broken };
    }

    /** Whether the work on an instance of the kind asks the llm: its operation, or its evaluate, is not deterministic. */
    private needsLlm(kind: string, work: { operation?: "create" | "update" }): boolean {
        const operations = [work.operation, "evaluate"].filter((name) => name !== undefined);

        return operations.some((name) => this.built.operations[`${kind}::${name}`]?.deterministic === false);
    }

    private has(kind: string, operation: string): boolean {
        return this.built.operations[`${kind}::${operation}`] !== undefined;
    }

    /**
     * Brings the instances of every demanded kind in line with what is asked of them: one is added for
     * every `kind:id` the uses of an instance with code names and nothing declares, and every one
     * already known is given what is asked of it now. The reference is recorded on whoever asked, so a
     * demanded instance is ordered before it, read as its context and invalidated as any dependency.
     *
     * Returns the keys it added or whose demands it changed, which is what must be checked again:
     * before the instances are ordered they all are anyway, and once one has been created, what its
     * code turned out to ask for is only known here. An instance of a demanded kind the manifest knows
     * and nothing asks for any more is left out, so it is forgotten, or reported as an orphan while its
     * code is still there.
     */
    private async demand(
        coded: Map<string, SlytherInstanceChecker["instance"]>,
        states: Map<string, SlytherInstanceChecker["state"]>,
        kinds: SlytherArtifactKind[],
    ): Promise<string[]> {
        const demanded = new Set(kinds.filter((kind) => kind.demanded).map((kind) => kind.name));

        if (demanded.size === 0) {
            return [];
        }

        const changed: string[] = [];

        for (const [key, demand] of SlytherInstanceChecker.demandsOf(states, demanded)) {
            const known = coded.get(key);

            if (!known) {
                const born = this.bornOf(key, kinds, demand);

                coded.set(key, born);
                states.set(key, await this.stateOf(key, born));
                changed.push(key);
            } else if (known.demands !== demand.demands) {
                known.demands = demand.demands;
                known.demandedBy = demand.demandedBy;
                changed.push(key);
            } else {
                known.demandedBy = demand.demandedBy;
            }

            for (const by of demand.demandedBy) {
                const demander = coded.get(by);

                if (demander && !demander.references.includes(key)) {
                    demander.references.push(key);
                }
            }
        }

        return changed;
    }

    /**
     * Reports every instance of a demanded kind that nothing asks for any more, once every instance has
     * been brought in line. What an artifact asks for is only certain once it has been written, so one
     * that stopped asking is only known here, after the instance that stopped was updated, and never
     * when the graph was first gathered. As with any orphan its code is not touched, and it is reported
     * on every check until its code is gone. One that was declared by hand is left alone: what declares
     * it keeps it, whether or not anything uses it.
     */
    private async reap(
        coded: Map<string, SlytherInstanceChecker["instance"]>,
        states: Map<string, SlytherInstanceChecker["state"]>,
        kinds: SlytherArtifactKind[],
        report: SlytherInstanceChecker["entry"][],
    ): Promise<void> {
        const demanded = new Set(kinds.filter((kind) => kind.demanded).map((kind) => kind.name));

        if (demanded.size === 0) {
            return;
        }

        const asked = SlytherInstanceChecker.demandsOf(states, demanded);

        for (const [key, instance] of coded) {
            const record = this.manifest.instances[key];

            if (!instance.demanded || asked.has(key) || this.declared.has(key) || !record) {
                continue;
            }

            record.result = "orphan";
            record.errors = [];
            instance.demands = undefined;
            coded.delete(key);

            const entry: SlytherInstanceChecker["entry"] = { key, status: "orphan", reason: "nothing asks for it any more", errors: [] };
            const at = report.findIndex((candidate) => candidate.key === key);

            if (at < 0) {
                report.push(entry);
            } else {
                report[at] = entry;
            }
        }
    }

    /**
     * What every instance of a demanded kind is asked for, from the uses of every instance that has
     * code: the spec of an artifact nobody declares is what the artifacts that use it ask of it. Each
     * demand is a `member (kind:id)` line, sorted, so the same demands read and hash the same however
     * the instances that make them happened to be ordered.
     */
    private static demandsOf(
        states: Map<string, SlytherInstanceChecker["state"]>,
        demanded: Set<string>,
    ): Map<string, { demands: string; demandedBy: string[] }> {
        const asked = new Map<string, { members: Set<string>; by: Set<string> }>();

        for (const [key, state] of states) {
            for (const [reference, members] of Object.entries(state.uses ?? {})) {
                if (reference === key || !demanded.has(reference.slice(0, reference.indexOf(":")))) {
                    continue;
                }

                const entry = asked.get(reference) ?? { members: new Set<string>(), by: new Set<string>() };

                for (const member of members) {
                    entry.members.add(`${member} (${key})`);
                }

                entry.by.add(key);
                asked.set(reference, entry);
            }
        }

        return new Map(
            [...asked].map(([reference, entry]) => [
                reference,
                { demands: [...entry.members].sort().join("\n"), demandedBy: [...entry.by].sort() },
            ]),
        );
    }

    /**
     * An instance of a demanded kind that nothing declares: it has an artifact of its own, with no args
     * and no prose, since everything it must do is what is asked of it.
     */
    private bornOf(key: string, kinds: SlytherArtifactKind[], demand: { demands: string; demandedBy: string[] }): SlytherInstanceChecker["instance"] {
        const boundary = key.indexOf(":");
        const kind = key.slice(0, boundary);
        const name = key.slice(boundary + 1);
        const rules = kinds.find((candidate) => candidate.name === kind)!;

        return {
            kind,
            name,
            artifact: new SlytherArtifact(kind, name, [], [], "", []),
            rules: rules.scopeHash,
            rulesText: rules.artifact.prose,
            references: [],
            leans: [],
            composite: false,
            demanded: true,
            demands: demand.demands,
            demandedBy: demand.demandedBy,
        };
    }

    /**
     * Writes what is asked of every instance of a demanded kind next to the manifest, one file per
     * instance, as the declaration nobody wrote, so a graph that grows out of the code is committed and
     * reviewed rather than only inferred, and what is written for one nothing asks for any more is removed.
     */
    private async writeDemanded(coded: Map<string, SlytherInstanceChecker["instance"]>): Promise<void> {
        const folder = join(dirname(this.path), SlytherInstanceChecker.DEMANDED);
        const written = new Set<string>();

        for (const instance of coded.values()) {
            if (instance.demands === undefined) {
                continue;
            }

            const path = join(folder, instance.kind, `${instance.name}.sly`);
            const body = instance.demands.split("\n").map((line) => `    ${line}`).join("\n");

            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, `${instance.kind} ${instance.name} {\n    What the artifacts that use it ask of it, and nothing more:\n\n${body}\n}\n`);
            written.add(path);
        }

        await SlytherInstanceChecker.prune(folder, written);
    }

    /**
     * The instances: every artifact whose kind has operations, with the instances with code it
     * references, which are its dependencies, what else it references, which it leans on, and the
     * instance that emitted it, if any.
     */
    private instancesOf(
        parsed: ParsedSlytherScript,
        kinds: SlytherArtifactKind[],
        expansions: Map<string, { emitted: string[] }>,
    ): Map<string, SlytherInstanceChecker["instance"]> {
        const rules = new Map(kinds.map((kind) => [kind.name, kind.scopeHash]));
        const written = new Map(kinds.map((kind) => [kind.name, kind.artifact.prose]));
        const checkable = new Set(kinds.filter((kind) => kind.operations.length > 0).map((kind) => kind.name));
        const composite = new Set(kinds.filter((kind) => kind.composite).map((kind) => kind.name));
        const demanded = new Set(kinds.filter((kind) => kind.demanded).map((kind) => kind.name));
        const parents = new Map([...expansions].flatMap(([parent, expansion]) => expansion.emitted.map((key) => [key, parent] as const)));
        const instances = new Map<string, SlytherInstanceChecker["instance"]>();

        for (const artifact of parsed.artifacts) {
            const key = `${artifact.artifact}:${artifact.name}`;

            if (checkable.has(artifact.artifact)) {
                const parent = parents.get(key);

                instances.set(key, {
                    kind: artifact.artifact,
                    name: artifact.name,
                    artifact,
                    rules: rules.get(artifact.artifact) ?? "",
                    rulesText: written.get(artifact.artifact) ?? "",
                    references: [],
                    leans: [],
                    composite: composite.has(artifact.artifact),
                    demanded: demanded.has(artifact.artifact),
                    ...(parent ? { parent } : {}),
                });
            }
        }

        for (const instance of instances.values()) {
            for (const reference of instance.artifact.references) {
                if (reference === `${instance.kind}:${instance.name}`) {
                    continue;
                }

                const target = instances.get(reference);

                (target && !target.composite ? instance.references : instance.leans).push(reference);
            }
        }

        return instances;
    }

    /** Where the instance is and what it looks like now: what located it, its segments, their hash, its signature and what it uses. */
    private async stateOf(
        key: string,
        instance: { kind: string; name: string; artifact: SlytherArtifact },
    ): Promise<{
        locatedWith?: string[];
        segments?: { path: string; content: string }[];
        contentHash?: string;
        signature?: string[];
        uses?: Record<string, string[]>;
        /** Why what locate printed cannot be read, when it printed a segment that is not there. */
        invalid?: string;
    }> {
        const args = this.argsFor(instance.kind, "locate", instance, key);
        const locatedWith = args.length > 1 ? { locatedWith: args } : {};
        const located = await this.runOperation(instance.kind, "locate", args);

        if (!located || located.code !== 0) {
            return { ...locatedWith };
        }

        const segments: { path: string; content: string }[] = [];

        for (const line of SlytherInstanceChecker.linesOf(located.stdout)) {
            const [, path, start, end] = SlytherInstanceChecker.SEGMENT.exec(line)!;

            try {
                segments.push({ path: path!, content: await this.contentOf(key, line, path!, start, end) });
            } catch (error) {
                return { ...locatedWith, invalid: error instanceof Error ? error.message : String(error) };
            }
        }

        segments.sort((a, b) => a.path.localeCompare(b.path) || a.content.localeCompare(b.content));

        const signature = await this.runOperation(instance.kind, "signature", this.argsFor(instance.kind, "signature", instance, key));
        const uses = await this.runOperation(instance.kind, "uses", this.argsFor(instance.kind, "uses", instance, key));

        return {
            ...locatedWith,
            segments,
            contentHash: SlytherInstanceChecker.hash(...segments.map((segment) => `${segment.path}\n${segment.content}`)),
            signature: signature?.code === 0 ? SlytherInstanceChecker.linesOf(signature.stdout) : undefined,
            uses: uses?.code === 0 ? SlytherInstanceChecker.usesOf(uses.stdout) : undefined,
        };
    }

    /**
     * What a segment holds: the lines of a file, or, for a folder, its listing, one entry per line with
     * a slash after the folders, so a folder changes when its structure does and not when a file in it does.
     */
    private async contentOf(key: string, line: string, path: string, start?: string, end?: string): Promise<string> {
        const target = join(this.cwd, path);
        const isFolder = await stat(target).then(
            (info) => info.isDirectory(),
            () => {
                throw new Error(
                    `the locate of ${key.split(":")[0]} printed "${line}", which does not exist: it must print a path, \`path:start-end\` for a range of lines, or \`path:line\` for one.`,
                );
            },
        );

        if (!isFolder) {
            const content = await readFile(target, "utf-8");

            // A segment with no end is a single line, so it ends where it starts.
            return start ? content.split("\n").slice(Number(start) - 1, Number(end ?? start)).join("\n") : content;
        }

        if (start) {
            throw new Error(`the locate of ${key.split(":")[0]} printed "${line}", but a folder has no lines.`);
        }

        const entries = await readdir(target, { withFileTypes: true });

        return entries
            .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
            .sort()
            .join("\n");
    }

    /** Locates the instance again after an operation changed it, and remembers what it found for the instances that reference it. */
    private async relocate(
        key: string,
        instance: { kind: string; name: string; artifact: SlytherArtifact },
        states: Map<string, Awaited<ReturnType<SlytherInstanceChecker["stateOf"]>>>,
    ): Promise<Awaited<ReturnType<SlytherInstanceChecker["stateOf"]>>> {
        const state = await this.stateOf(key, instance);

        states.set(key, state);

        return state;
    }

    /**
     * Why the instance must be evaluated again: it never was, its spec changed, its code changed, what
     * evaluates it changed, or an instance it references changed in a way it uses. A reason that ends
     * as GONE means it uses a key that is gone, so it is certainly broken. Null when it is up to date.
     */
    private changeOf(
        key: string,
        instance: { kind: string; artifact: SlytherArtifact; leans: string[]; rules: string; demands?: string },
        state: SlytherInstanceChecker["state"],
        states: Map<string, SlytherInstanceChecker["state"]>,
    ): string | null {
        const record = this.manifest.instances[key];
        const { kind } = instance;

        if (!record || record.result === "missing") {
            return SlytherInstanceChecker.NEW;
        }

        if (record.specHash !== this.specHashOf(instance)) {
            return SlytherInstanceChecker.SPEC;
        }

        if ((record.rulesHash ?? instance.rules) !== instance.rules) {
            return SlytherInstanceChecker.RULES;
        }

        if (record.contentHash !== state.contentHash) {
            return "its code changed";
        }

        if (record.evaluatedWith !== this.evaluatedWithOf(kind)) {
            return "what evaluates it changed";
        }

        for (const [reference, seen] of Object.entries(record.dependencies)) {
            const current = states.get(reference);
            const used = state.uses?.[reference] ?? ["*"];

            if (!current || current.segments === undefined) {
                return `${reference}, which it references, is missing`;
            }

            if (!seen.signature || !current.signature) {
                if (seen.contentHash !== current.contentHash) {
                    return `${reference}, which it references, changed`;
                }

                continue;
            }

            const { changed, added } = SlytherInstanceChecker.diffOf(seen.signature, current.signature);
            const keys = new Set(current.signature.map((line) => SlytherInstanceChecker.keyOf(line)));
            const gone = used.find((use) => use !== "*" && use !== "**" && !keys.has(use));

            if (gone) {
                return `uses ${gone} of ${reference}${SlytherInstanceChecker.GONE}`;
            }

            if (used.includes("**") && (changed.length > 0 || added.length > 0)) {
                return `${reference}, which it depends on entirely, changed`;
            }

            if (used.includes("*") && changed.length > 0) {
                return `${reference}, which it uses, changed ${changed.join(", ")}`;
            }

            const hit = used.find((use) => changed.includes(use));

            if (hit) {
                return `uses ${hit} of ${reference}, which changed`;
            }
        }

        return record.result === "fail" && this.options.compile ? "it failed its last evaluation" : null;
    }

    /**
     * Runs the evaluate operation of the kind on the instance: its scripts with the id, then its prompts
     * through the generator, each followed by what the instance must do, as declared, and its code.
     */
    private async evaluate(
        instance: { kind: string; name: string; artifact: SlytherArtifact; demands?: string },
        key: string,
        state: SlytherInstanceChecker["state"],
    ): Promise<{ pass: boolean; errors: string[] }> {
        const operation = this.built.operations[`${instance.kind}::evaluate`];

        if (!operation) {
            return { pass: true, errors: [] };
        }

        for (const step of operation.steps) {
            if (step.run) {
                this.options.say?.(`${key}: evaluating with ${step.run.join(" ")}`);

                const result = await ProcessUtils.run([...step.run, ...SlytherInstanceChecker.argsOf(operation, instance, key, [])], { cwd: this.cwd, timeout: SlytherInstanceChecker.TIMEOUT });

                if (result.code !== 0) {
                    return { pass: false, errors: SlytherInstanceChecker.linesOf(`${result.stdout}\n${result.stderr}`) };
                }

                continue;
            }

            const prompt = [
                await readFile(join(this.cwd, this.artifacts, step.path), "utf-8"),
                `## The ${instance.kind} to evaluate: ${instance.name}`,
                "",
                "### What it must do",
                "",
                SlytherInstanceChecker.mustOf(instance),
                "",
                "### Its code",
                "",
                ...state.segments!.map((segment) => `#### ${segment.path}\n\n\`\`\`\n${segment.content}\n\`\`\``),
                "",
                ...SlytherInstanceChecker.section("### What it references", this.contextOf(instance, "####")),
                "Reply with `pass` true when it complies with everything above, else false with one entry in `errors` per discrepancy.",
            ].join("\n");
            this.options.say?.(`${key}: evaluating with the llm (${step.path})`);

            const verdict = await this.generator.ask<{ pass: boolean; errors: string[] }>(prompt, SlytherInstanceChecker.VERDICT);

            if (!verdict.result.pass) {
                return { pass: false, errors: verdict.result.errors };
            }
        }

        return { pass: true, errors: [] };
    }

    /**
     * Runs the create or update operation of the kind on the instance, with its params filled from the
     * instance: its scripts in order, or its markdown through the generator with the tools, followed by
     * the errors it is run to fix, when there are any.
     *
     * A script is handed its params as its args, so it always has them. A markdown is handed them twice:
     * substituted where it wrote `{param}`, and as the instance it is run on, with the value of every
     * param and what the instance must do, as declared. The substitution alone is not enough, since
     * nothing makes the markdown mention a param, and one that never does would otherwise run without
     * ever being told which instance it is working on.
     *
     * An update is told what changed as well, so it is not left to find it by reading code that was
     * written against the declaration as it was before.
     */
    private async perform(
        name: "create" | "update",
        instance: SlytherInstanceChecker["instance"],
        key: string,
        errors: string[],
        reason?: string,
    ): Promise<void> {
        const operation = this.built.operations[`${instance.kind}::${name}`]!;
        const args = SlytherInstanceChecker.argsOf(operation, instance, key, errors);

        const verb = name === "create" ? "creating" : "updating";

        if (operation.deterministic) {
            for (const step of operation.steps) {
                this.options.say?.(`${key}: ${verb} with ${step.run!.join(" ")}`);

                const result = await ProcessUtils.run([...step.run!, ...args], { cwd: this.cwd, timeout: SlytherInstanceChecker.TIMEOUT });

                if (result.code !== 0) {
                    throw new Error(`${name === "create" ? "Creating" : "Updating"} ${key} failed:\n${result.stderr || result.stdout}`);
                }
            }

            return;
        }

        let markdown = await readFile(join(this.cwd, this.artifacts, operation.entry!), "utf-8");

        operation.params.forEach((param, index) => {
            markdown = markdown.replaceAll(`{${param.name}}`, args[index]!);
        });

        // The errors are given their own section below, so they are not repeated among the params.
        const given = operation.params.map((param, index) => `- ${param.name}: ${args[index]!}`).filter((_, index) => operation.params[index]!.name !== "errors");

        markdown = [
            markdown,
            `## The ${instance.kind} to ${name}: ${instance.name}`,
            "",
            ...SlytherInstanceChecker.section("### Its params", given),
            "",
            "### What it must do",
            "",
            SlytherInstanceChecker.mustOf(instance),
            "",
        ].join("\n");

        const changed = name === "update" ? this.changedOf(key, instance, reason) : [];

        if (changed.length > 0) {
            markdown = `${markdown}\n${changed.join("\n")}`;
        }

        const context = SlytherInstanceChecker.section("## What it references", this.contextOf(instance, "###"));

        if (context.length > 0) {
            markdown = `${markdown}\n${context.join("\n")}`;
        }

        if (errors.length > 0) {
            markdown = `${markdown}\n## Why it failed evaluation\n\n${errors.map((error) => `- ${error}`).join("\n")}\n`;
        }

        this.options.say?.(`${key}: ${verb} with the llm (${operation.entry})`);
        await this.generator.execute(markdown, this.cwd);
    }

    /**
     * Why the instance is being updated: what triggered it and, against what it was last brought in line
     * with, the diff of its declaration and of the rules of its kind.
     *
     * The code was written against the minus side of those diffs, so where it still says what a `-` line
     * took away, the code is what is wrong, and saying so is what keeps an update from reading the code
     * as evidence of what is meant and leaving it as it found it. Nothing is said when there is no text
     * to diff against, which is every instance a manifest written before it was recorded knows.
     */
    private changedOf(key: string, instance: SlytherInstanceChecker["instance"], reason: string | undefined): string[] {
        const record = this.manifest.instances[key];

        if (!record || reason === undefined) {
            return [];
        }

        const spec = record.spec === undefined ? [] : StringUtils.diff(record.spec, this.specTextOf(instance));
        const rules = record.rules === undefined ? [] : StringUtils.diff(record.rules, instance.rulesText);
        const fenced = (lines: string[]): string[] => ["```diff", ...lines, "```", ""];

        return [
            "## Why it is being updated",
            "",
            reason,
            "",
            ...(spec.length + rules.length === 0
                ? []
                : [
                      "The prose rules over the code. The code was written against what the `-` lines below say, so",
                      "wherever it still says one of them, the code is what is wrong, never the prose. Bring all of it",
                      "in line, and leave the rest of the code alone.",
                      "",
                  ]),
            ...SlytherInstanceChecker.section("### What changed in what it must do", spec.length === 0 ? [] : fenced(spec)),
            ...SlytherInstanceChecker.section(`### What changed in the rules of every ${instance.kind}`, rules.length === 0 ? [] : fenced(rules)),
        ];
    }

    /**
     * The args an operation is run with for an instance, one per param, by the name of the param: id is
     * the name of the instance, errors is the errors it is run to fix, a param named as an arg of the
     * instance is the value of that arg, and any other is the prose of the instance, unless it is
     * optional, which the instance simply did not give. Throws when a param that is not optional gets
     * nothing.
     */
    private static argsOf(
        operation: SlytherArtifactManifest["operations"][string],
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

    /**
     * The args the read-only operation of the kind runs with for the instance, filled as create fills
     * them, so a kind whose locate needs more than the id gets it from the args of the instance.
     */
    private argsFor(kind: string, operation: string, instance: { name: string; artifact: SlytherArtifact; demands?: string }, key: string): string[] {
        const record = this.built.operations[`${kind}::${operation}`];

        return record ? SlytherInstanceChecker.argsOf(record, instance, key, []) : [instance.name];
    }

    /**
     * What the instance must do, as whoever writes or evaluates it reads it: its declaration and, when
     * its kind is demanded, what the artifacts that use it ask of it, which is the whole of its spec
     * when nothing declared it, and what a declaration adds to when one did.
     */
    private static mustOf(instance: { artifact: SlytherArtifact; demands?: string }): string {
        if (instance.demands === undefined) {
            return SlytherInstanceChecker.specOf(instance.artifact);
        }

        const declared = instance.artifact.prose || instance.artifact.args.length > 0 ? [SlytherInstanceChecker.specOf(instance.artifact), ""] : [];

        return [...declared, "What the artifacts that use it ask of it, and nothing more:", "", instance.demands || "(nothing)"].join("\n");
    }

    /** The instance as declared, for the generator to read: its args, one per line, and its prose. */
    private static specOf(artifact: SlytherArtifact): string {
        const args = artifact.args.map((arg) => `- ${arg.name}: ${String(arg.value)}`);

        return [...args, ...(args.length > 0 && artifact.prose ? [""] : []), artifact.prose || "(no further description)"].join("\n");
    }

    /** The heading and the sections under it, or nothing when there are no sections. */
    private static section(heading: string, sections: string[]): string[] {
        return sections.length === 0 ? [] : [heading, "", ...sections];
    }

    /** The hash of every script and prompt that takes part in evaluating an instance of the kind, or in expanding it. */
    private evaluatedWithOf(kind: string): string {
        const paths = ["locate", "signature", "uses", "evaluate", SlytherArtifactKind.EXPAND].flatMap(
            (operation) => this.built.operations[`${kind}::${operation}`]?.steps.map((step) => step.path) ?? [],
        );

        return SlytherInstanceChecker.hash(...paths.map((path) => `${path}@${this.built.files[path]?.outputHash ?? ""}`));
    }

    /**
     * Warns about every id list prints that the script does not declare. A demanded kind is left out:
     * nothing declares its instances, so an id nobody wrote down is what it looks like when it works.
     */
    private async warnUndeclared(kinds: SlytherArtifactKind[], instances: Map<string, { kind: string; name: string }>): Promise<void> {
        for (const kind of kinds) {
            if (kind.demanded) {
                continue;
            }

            const listed = await this.runOperation(kind.name, "list", []);

            if (!listed || listed.code !== 0) {
                continue;
            }

            for (const id of SlytherInstanceChecker.linesOf(listed.stdout)) {
                if (!instances.has(`${kind.name}:${id}`)) {
                    this.options.log?.(`warning: the ${kind.name} "${id}" exists but is not declared`);
                }
            }
        }
    }

    /** Runs a deterministic operation of the kind, if it is built, and returns what it printed and its code. */
    private async runOperation(kind: string, operation: string, args: string[]): Promise<{ code: number; stdout: string } | undefined> {
        const record = this.built.operations[`${kind}::${operation}`];

        if (!record?.deterministic) {
            return undefined;
        }

        let stdout = "";

        for (const step of record.steps) {
            const result = await ProcessUtils.run([...step.run!, ...args], { cwd: this.cwd, timeout: SlytherInstanceChecker.TIMEOUT });

            if (result.code !== 0) {
                return { code: result.code, stdout: "" };
            }

            stdout = result.stdout;
        }

        return { code: 0, stdout };
    }

    /**
     * The instances in an order where every one comes after the ones it references, so a dependency is
     * evaluated, and fixed, before what depends on it. A cycle is ordered as written.
     */
    private static orderOf(instances: Map<string, { references: string[] }>): string[] {
        const order: string[] = [];
        const visited = new Set<string>();
        const visit = (key: string): void => {
            if (visited.has(key)) {
                return;
            }

            visited.add(key);

            for (const reference of instances.get(key)!.references) {
                visit(reference);
            }

            order.push(key);
        };

        for (const key of instances.keys()) {
            visit(key);
        }

        return order;
    }

    /** The keys whose shape changed or that are gone, and the keys that are new, between two signatures. */
    private static diffOf(before: string[], after: string[]): { changed: string[]; added: string[] } {
        const shapes = (lines: string[]) => new Map(lines.map((line) => [SlytherInstanceChecker.keyOf(line), line]));
        const old = shapes(before);
        const current = shapes(after);

        return {
            changed: [...old].filter(([key, line]) => current.get(key) !== line).map(([key]) => key),
            added: [...current.keys()].filter((key) => !old.has(key)),
        };
    }

    /** The `kind:id key` lines of uses, grouped by `kind:id`. */
    private static usesOf(output: string): Record<string, string[]> {
        const uses: Record<string, string[]> = {};

        for (const line of SlytherInstanceChecker.linesOf(output)) {
            const [reference, key] = line.split(/\s+/) as [string, string];

            uses[reference] = [...(uses[reference] ?? []), key];
        }

        return uses;
    }

    private static keyOf(line: string): string {
        return line.split(/\s+/)[0]!;
    }

    private static linesOf(output: string): string[] {
        return output.split("\n").filter((line) => line.trim().length > 0);
    }

    private static hash(...parts: string[]): string {
        return createHash("sha256").update(parts.join("\n--\n")).digest("hex");
    }

    private static emptyRecord(): SlytherInstanceManifest["instances"][string] {
        return { specHash: "", rulesHash: "", contentHash: "", dependencies: {}, evaluatedWith: "", result: "missing", errors: [] };
    }

    /** What happened to an instance: its status, why, its errors, and the instance that emitted it, if any. */
    declare readonly entry: {
        key: string;
        status: "created" | "updated" | "fixed" | "pass" | "fail" | "missing" | "kept" | "expanded" | "orphan";
        reason?: string;
        errors: string[];
        parent?: string;
    };

    /** An instance as declared: the instances with code it references, what else it leans on, and who emitted it. */
    private declare readonly instance: {
        kind: string;
        name: string;
        artifact: SlytherArtifact;
        /** The scope hash of its kind: the rules every instance of it must follow, so a change to them is noticed. */
        rules: string;
        /** The rules of its kind as written, so an update may be shown what changed in them. */
        rulesText: string;
        references: string[];
        leans: string[];
        composite: boolean;
        /** Whether its kind is demanded, so nothing declares it and its spec is what the artifacts that use it ask. */
        demanded: boolean;
        /** What those artifacts ask of it, one `member (kind:id)` per line, when its kind is demanded. */
        demands?: string;
        /** Every instance whose uses asks for it, when its kind is demanded, so it is an orphan once none does. */
        demandedBy?: string[];
        parent?: string;
    };

    /** Where an instance is and what it looks like now. */
    private declare readonly state: Awaited<ReturnType<SlytherInstanceChecker["stateOf"]>>;
}
