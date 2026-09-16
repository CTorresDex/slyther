// Imports
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ProcessUtils } from "./ProcessUtils.class.ts";
import type { SlytherArtifactManifest } from "./SlytherArtifactManifest.class.ts";
import type { SlytherArtifactKind } from "./SlytherArtifactKind.class.ts";
import type { SlytherGenerator } from "./SlytherGenerator.class.ts";
import { SlytherInstanceManifest } from "./SlytherInstanceManifest.class.ts";
import type { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";

export class SlytherInstanceChecker {
    /** What an llm step of evaluate must reply. */
    private static readonly VERDICT = {
        type: "object",
        properties: { pass: { type: "boolean" }, errors: { type: "array", items: { type: "string" } } },
        required: ["pass", "errors"],
    };
    /** `path` or `path:start-end`: a segment locate prints. */
    private static readonly SEGMENT = /^(.+?)(?::(\d+)-(\d+))?$/;
    /** How the reason of an instance that uses a key that is gone ends. */
    private static readonly GONE = ", which no longer exists";

    private manifest!: SlytherInstanceManifest;

    constructor(
        /** The folder the code of the project lives in, where every script runs. */
        private readonly cwd: string,
        /** The folder the operations are built into, relative to where the scripts run. */
        private readonly artifacts: string,
        /** Where the instances manifest is written. */
        private readonly path: string,
        private readonly built: SlytherArtifactManifest,
        private readonly generator: SlytherGenerator,
        private readonly options: { fix?: boolean; max?: number; log?: (line: string) => void } = {},
    ) {}

    /**
     * Checks every instance declared in the script whose kind has operations: locates it, decides
     * whether it must be evaluated again, from its own code, the scripts it is evaluated with and what
     * it uses of the instances it references, evaluates it when it must, in an order where every
     * instance comes after the ones it references, and records the outcome. With fix, an instance that
     * fails is updated and evaluated once more. Returns what happened to every instance.
     */
    async check(
        parsed: ParsedSlytherScript,
        kinds: SlytherArtifactKind[],
    ): Promise<{ key: string; status: "pass" | "fail" | "missing" | "kept" | "fixed"; reason?: string; errors: string[] }[]> {
        this.manifest = await SlytherInstanceManifest.load(this.path);

        const instances = this.instancesOf(parsed, kinds);
        const report: { key: string; status: "pass" | "fail" | "missing" | "kept" | "fixed"; reason?: string; errors: string[] }[] = [];

        for (const key of Object.keys(this.manifest.instances)) {
            if (!instances.has(key)) {
                delete this.manifest.instances[key];
            }
        }

        const states = new Map<string, Awaited<ReturnType<SlytherInstanceChecker["stateOf"]>>>();

        for (const [key, instance] of instances) {
            states.set(key, await this.stateOf(key, instance));
        }

        await this.warnUndeclared(kinds, instances);

        const order = SlytherInstanceChecker.orderOf(instances, states);
        const pending = order.filter((key) => {
            const state = states.get(key)!;

            return state.segments !== undefined && this.reasonToEvaluate(key, state, states) !== null;
        });
        const llm = pending.filter((key) => !this.built.operations[`${instances.get(key)!.kind}::evaluate`]?.deterministic).length;

        if (this.options.max !== undefined && llm > this.options.max) {
            throw new Error(`${llm} instances need an evaluation with the llm, more than the ${this.options.max} allowed: raise --max or narrow the change.`);
        }

        if (pending.length > 0) {
            this.options.log?.(`${pending.length} of ${instances.size} instances need evaluating, ${llm} with the llm`);
        }

        for (const key of order) {
            const instance = instances.get(key)!;
            let state = states.get(key)!;

            if (state.segments === undefined) {
                this.manifest.instances[key] = { ...SlytherInstanceChecker.emptyRecord(), result: "missing", errors: [] };
                report.push({ key, status: "missing", errors: [] });
                continue;
            }

            const reason = this.reasonToEvaluate(key, state, states);

            if (reason === null) {
                const record = this.manifest.instances[key]!;

                report.push(
                    record.result === "fail"
                        ? { key, status: "fail", reason: "unchanged since it failed", errors: record.errors }
                        : { key, status: "kept", errors: [] },
                );
                continue;
            }

            this.options.log?.(`${key}: ${reason.text}`);

            let verdict = reason.broken ? { pass: false, errors: [reason.text] } : await this.evaluate(instance, key, state);
            let status: "pass" | "fail" | "fixed" = verdict.pass ? "pass" : "fail";

            if (!verdict.pass && this.options.fix && this.built.operations[`${instance.kind}::update`]) {
                this.options.log?.(`${key}: updating`);
                await this.update(instance, key, verdict.errors);
                state = await this.stateOf(key, instance);
                states.set(key, state);
                verdict = state.segments === undefined ? { pass: false, errors: ["the update removed it"] } : await this.evaluate(instance, key, state);
                status = verdict.pass ? "fixed" : "fail";
            }

            this.manifest.instances[key] = {
                contentHash: state.contentHash!,
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
            report.push({ key, status, reason: reason.text, errors: verdict.errors });
        }

        await this.manifest.save();

        return report;
    }

    /** The instances: every artifact whose kind has operations, with the ones it references among them. */
    private instancesOf(
        parsed: ParsedSlytherScript,
        kinds: SlytherArtifactKind[],
    ): Map<string, { kind: string; name: string; references: string[] }> {
        const checkable = new Set(kinds.filter((kind) => kind.operations.length > 0).map((kind) => kind.name));
        const instances = new Map<string, { kind: string; name: string; references: string[] }>();

        for (const artifact of parsed.artifacts) {
            if (checkable.has(artifact.artifact)) {
                instances.set(`${artifact.artifact}:${artifact.name}`, { kind: artifact.artifact, name: artifact.name, references: [] });
            }
        }

        for (const artifact of parsed.artifacts) {
            const instance = instances.get(`${artifact.artifact}:${artifact.name}`);

            if (instance) {
                instance.references = artifact.references.filter((reference) => instances.has(reference) && reference !== `${artifact.artifact}:${artifact.name}`);
            }
        }

        return instances;
    }

    /** Where the instance is and what it looks like now: its segments, their hash, its signature and what it uses. */
    private async stateOf(
        key: string,
        instance: { kind: string; name: string },
    ): Promise<{ segments?: { path: string; content: string }[]; contentHash?: string; signature?: string[]; uses?: Record<string, string[]> }> {
        const located = await this.runOperation(instance.kind, "locate", [instance.name]);

        if (!located || located.code !== 0) {
            return {};
        }

        const segments: { path: string; content: string }[] = [];

        for (const line of SlytherInstanceChecker.linesOf(located.stdout)) {
            const [, path, start, end] = SlytherInstanceChecker.SEGMENT.exec(line)!;

            segments.push({ path: path!, content: await this.contentOf(key, line, path!, start, end) });
        }

        segments.sort((a, b) => a.path.localeCompare(b.path) || a.content.localeCompare(b.content));

        const signature = await this.runOperation(instance.kind, "signature", [instance.name]);
        const uses = await this.runOperation(instance.kind, "uses", [instance.name]);

        return {
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
                throw new Error(`${key} is located at "${line}", which does not exist.`);
            },
        );

        if (!isFolder) {
            const content = await readFile(target, "utf-8");

            return start ? content.split("\n").slice(Number(start) - 1, Number(end)).join("\n") : content;
        }

        if (start) {
            throw new Error(`${key} is located at "${line}", but a folder has no lines.`);
        }

        const entries = await readdir(target, { withFileTypes: true });

        return entries
            .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
            .sort()
            .join("\n");
    }

    /**
     * Why the instance must be evaluated again: it never was, its code changed, what evaluates it
     * changed, or an instance it references changed in a way it uses. Broken when it uses a key that
     * is gone, so it fails without being evaluated. Null when it is up to date.
     */
    private reasonToEvaluate(
        key: string,
        state: Awaited<ReturnType<SlytherInstanceChecker["stateOf"]>>,
        states: Map<string, Awaited<ReturnType<SlytherInstanceChecker["stateOf"]>>>,
    ): { text: string; broken: boolean } | null {
        const reason = this.changeOf(key, state, states);

        return reason === null ? null : { text: reason, broken: reason.endsWith(SlytherInstanceChecker.GONE) };
    }

    private changeOf(
        key: string,
        state: Awaited<ReturnType<SlytherInstanceChecker["stateOf"]>>,
        states: Map<string, Awaited<ReturnType<SlytherInstanceChecker["stateOf"]>>>,
    ): string | null {
        const record = this.manifest.instances[key];
        const [kind] = key.split(":") as [string];

        if (!record || record.result === "missing") {
            return "never evaluated";
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

        return record.result === "fail" && this.options.fix ? "it failed last time" : null;
    }

    /** Runs the evaluate operation of the kind on the instance: its scripts, then its prompts through the generator. */
    private async evaluate(
        instance: { kind: string; name: string },
        key: string,
        state: Awaited<ReturnType<SlytherInstanceChecker["stateOf"]>>,
    ): Promise<{ pass: boolean; errors: string[] }> {
        const operation = this.built.operations[`${instance.kind}::evaluate`];

        if (!operation) {
            return { pass: true, errors: [] };
        }

        for (const step of operation.steps) {
            if (step.run) {
                const result = await ProcessUtils.run([...step.run, instance.name], { cwd: this.cwd });

                if (result.code !== 0) {
                    return { pass: false, errors: SlytherInstanceChecker.linesOf(`${result.stdout}\n${result.stderr}`) };
                }

                continue;
            }

            const prompt = [
                await readFile(join(this.cwd, this.artifacts, step.path), "utf-8"),
                `## The ${instance.kind} to evaluate: ${instance.name}`,
                "",
                ...state.segments!.map((segment) => `### ${segment.path}\n\n\`\`\`\n${segment.content}\n\`\`\``),
                "",
                "Reply with `pass` true when it complies with everything above, else false with one entry in `errors` per discrepancy.",
            ].join("\n");
            const verdict = await this.generator.ask<{ pass: boolean; errors: string[] }>(prompt, SlytherInstanceChecker.VERDICT);

            if (!verdict.result.pass) {
                return { pass: false, errors: verdict.result.errors };
            }
        }

        return { pass: true, errors: [] };
    }

    /**
     * Runs the update operation of the kind on the instance, with the id as the param named id and the
     * errors as any other param: its scripts, or its markdown through the generator with the tools.
     */
    private async update(instance: { kind: string; name: string }, key: string, errors: string[]): Promise<void> {
        const operation = this.built.operations[`${instance.kind}::update`]!;
        const args = operation.params.map((param) => (param.name === "id" ? instance.name : errors.join("\n")));

        if (operation.deterministic) {
            for (const step of operation.steps) {
                const result = await ProcessUtils.run([...step.run!, ...args], { cwd: this.cwd });

                if (result.code !== 0) {
                    throw new Error(`Updating ${key} failed:\n${result.stderr || result.stdout}`);
                }
            }

            return;
        }

        let markdown = await readFile(join(this.cwd, this.artifacts, operation.entry!), "utf-8");

        operation.params.forEach((param, index) => {
            markdown = markdown.replaceAll(`{${param.name}}`, args[index]!);
        });

        await this.generator.execute(`${markdown}\n## Why it failed evaluation\n\n${errors.map((error) => `- ${error}`).join("\n")}\n`, this.cwd);
    }

    /** The hash of every script and prompt that takes part in evaluating an instance of the kind. */
    private evaluatedWithOf(kind: string): string {
        const paths = ["locate", "signature", "uses", "evaluate"].flatMap(
            (operation) => this.built.operations[`${kind}::${operation}`]?.steps.map((step) => step.path) ?? [],
        );

        return SlytherInstanceChecker.hash(...paths.map((path) => `${path}@${this.built.files[path]?.outputHash ?? ""}`));
    }

    /** Warns about every id list prints that the script does not declare. */
    private async warnUndeclared(kinds: SlytherArtifactKind[], instances: Map<string, { kind: string; name: string }>): Promise<void> {
        for (const kind of kinds) {
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
            const result = await ProcessUtils.run([...step.run!, ...args], { cwd: this.cwd });

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
    private static orderOf(
        instances: Map<string, { references: string[] }>,
        states: Map<string, unknown>,
    ): string[] {
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
        return { contentHash: "", dependencies: {}, evaluatedWith: "", result: "missing", errors: [] };
    }
}
