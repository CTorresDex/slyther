// Imports
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { ProcessUtils } from "./ProcessUtils.class.ts";
import { SlytherArtifact } from "./SlytherArtifact.class.ts";
import { SlytherArtifactManifest } from "./SlytherArtifactManifest.class.ts";
import { SlytherArtifactKind } from "./SlytherArtifactKind.class.ts";
import { SlytherExpansion } from "./SlytherExpansion.class.ts";
import type { SlytherGenerator } from "./SlytherGenerator.class.ts";
import { SlytherInstanceChecker } from "./SlytherInstanceChecker.class.ts";
import type { SlytherRunScript } from "./SlytherRunScript.class.ts";
import { SlytherRole } from "./SlytherRole.class.ts";
import { SlytherRuntime } from "./SlytherRuntime.class.ts";
import { SlytherVerifier } from "./SlytherVerifier.class.ts";
import { StringUtils } from "./StringUtils.class.ts";

export class SlytherArtifactBuilder {
    /** The folder, inside the artifacts folder, where a negative is written while the check of its rule is run against it. */
    private static readonly NEGATIVES = ".negatives";
    /** A fenced block of code inside the prose of a negative, which is the code it holds, with the lang the fence names and, after it, the name of the file it is. */
    private static readonly FENCED = /```([\w-]*)(?:[ \t]+(\S+))?[ \t]*\n([\s\S]*?)```/;
    /** How many times a script that fails verification is sent back to be fixed before the build fails. */
    static readonly ATTEMPTS = 3;
    /** The name of the markdown that orchestrates an operation that is not deterministic. */
    private static readonly ENTRY = "operation.md";
    /** The operations built first, since the others may call them. */
    private static readonly FIRST = ["locate", "list", "signature", "uses"];
    /** The first operations that describe an artifact, built side by side: neither needs the other, so neither is offered the other. */
    private static readonly PEERS = ["signature", "uses"];
    /** The operations that read an instance rather than write or judge it, which are never shown its rules: what they find is not what must be true of it. */
    private static readonly READS = ["locate", "list", "signature", "uses", SlytherArtifactKind.EXPAND];
    /** How many scripts are written by the llm at once, when nothing asks for another number. */
    static readonly CONCURRENCY = 4;
    /** The folder the scripts that run the project are built into, a name no kind can take. */
    static readonly RUN = "@run";

    private manifest!: SlytherArtifactManifest;
    private installed = new Map<string, string>();
    /** Who plays every role the project binds, which is who writes and who reviews every script. */
    private roles = new Map<string, SlytherRole["binding"]>();
    /** The last save of the manifest, so saves of scripts built side by side never write over each other. */
    private saving: Promise<void> = Promise.resolve();
    /** The last install or verification, which run one at a time, since an install changes what every script runs with. */
    private locked: Promise<void> = Promise.resolve();
    /** What every script under way is doing and since when, so what is waited on names them all, not the last one to speak. */
    private working = new Map<string, { doing: string; since: number }>();

    constructor(
        /** The folder the code of the project lives in, where every script runs. */
        private readonly cwd: string,
        /** The folder the artifacts are built into, relative to where the scripts run. */
        private readonly artifacts: string,
        private readonly generator: SlytherGenerator,
        /**
         * attempts: how many times a script may be fixed; concurrency: how many scripts the llm writes at once;
         * log: prints a finished line; say: names what is being waited on, as a label or as what gives it
         * each time it is drawn, so how long each wait has lasted stays current.
         */
        private readonly options: {
            attempts?: number;
            concurrency?: number;
            log?: (line: string) => void;
            say?: (label: string | (() => string)) => void;
        } = {},
    ) {}

    /**
     * Brings the artifacts folder in line with the kinds and the scripts that run the project: writes what
     * is new or changed, removes what is gone, and leaves alone what is up to date. Returns what it did to
     * every file, and throws when a script cannot be made to pass verification. A script waits only for
     * the operations it is offered, and the scripts that run the project for everything before them, so the rest
     * are written side by side, up to #{CONCURRENCY} at once; once one fails, what has not started never
     * does, what is under way finishes, and the first failure is thrown. The parsed script the
     * kinds come from is what the expand of a composite kind is verified against, since what it prints
     * may reference any artifact of it.
     */
    async build(
        kinds: SlytherArtifactKind[],
        scripts: SlytherRunScript[] = [],
        parsed: ParsedSlytherScript = new ParsedSlytherScript(
            kinds.flatMap((kind) => [kind.artifact, ...kind.operations.flatMap((operation) => [operation.artifact, ...operation.steps.map((step) => step.artifact)])]),
            new Map(),
            new Map(),
        ),
    ): Promise<{ path: string; status: "built" | "rebuilt" | "kept" | "removed" }[]> {
        this.manifest = await SlytherArtifactManifest.load(join(this.cwd, this.artifacts, SlytherArtifactManifest.FILE));
        this.installed = new Map();
        this.roles = parsed.roles;
        this.saving = Promise.resolve();
        this.locked = Promise.resolve();
        this.working = new Map();

        const desired = [...this.desiredOf(kinds, parsed), ...this.desiredOfScripts(kinds, scripts)];
        const report: { path: string; status: "built" | "rebuilt" | "kept" | "removed" }[] = [];

        for (const path of Object.keys(this.manifest.files)) {
            if (!desired.some((entry) => entry.path === path)) {
                await rm(join(this.cwd, this.artifacts, path), { force: true });
                await this.prune(dirname(join(this.cwd, this.artifacts, path)));
                delete this.manifest.files[path];
                report.push({ path, status: "removed" });
            }
        }

        for (const key of Object.keys(this.manifest.operations)) {
            if (!desired.some((entry) => entry.owner.operation === key)) {
                delete this.manifest.operations[key];
            }
        }

        for (const key of Object.keys(this.manifest.scripts)) {
            if (!desired.some((entry) => entry.owner.script === key)) {
                delete this.manifest.scripts[key];
            }
        }

        const reasons = new Map<string, string | null>();

        for (const entry of desired) {
            reasons.set(entry.path, await this.reasonToBuild(entry));
        }

        const pending = desired.filter((entry) => reasons.get(entry.path) !== null);
        const generated = pending.filter((entry) => entry.script !== undefined).length;

        if (pending.length > 0) {
            this.options.log?.(`${pending.length} of ${desired.length} artifact files to build, ${generated} with the llm`);
        }

        // Every record is in place before anything is built: a script is offered what the manifest records as built.
        for (const entry of desired) {
            if (entry.owner.operation) {
                this.manifest.operations[entry.owner.operation] = entry.owner.record as SlytherArtifactManifest["operations"][string];
            } else {
                this.manifest.scripts[entry.owner.script!] = entry.owner.record as SlytherArtifactManifest["scripts"][string];
            }
        }

        const statuses = new Map<string, "built" | "rebuilt" | "kept">();
        const tasks = new Map<string, Promise<void>>();
        const slots = SlytherArtifactBuilder.slots(Math.max(1, this.options.concurrency ?? SlytherArtifactBuilder.CONCURRENCY));
        let failure: { error: unknown } | undefined;

        const taskOf = (entry: SlytherArtifactBuilder["entry"]): Promise<void> => {
            const known = tasks.get(entry.path);

            if (known) {
                return known;
            }

            const task = (async () => {
                await Promise.all(this.dependenciesOf(entry, pending).map(taskOf));

                const reason = reasons.get(entry.path)!;
                const status = reason === "new" ? "built" : "rebuilt";
                let fixes = 0;
                let started = Date.now();

                if (entry.script) {
                    await slots.acquire();

                    try {
                        if (failure) {
                            return;
                        }

                        started = Date.now();
                        this.doing(entry.path, "writing");
                        fixes = await this.buildScript(entry);
                    } finally {
                        this.done(entry.path);
                        slots.release();
                    }
                } else {
                    if (failure) {
                        return;
                    }

                    await this.write(entry.path, entry.content!, entry.inputHash);
                }

                await this.save();
                this.options.log?.(`${status} ${entry.path}: ${reason} (${StringUtils.duration(Date.now() - started)}${fixes > 0 ? `, ${fixes} fix${fixes === 1 ? "" : "es"}` : ""})`);
                statuses.set(entry.path, status);
            })().catch((error) => {
                failure ??= { error };

                throw error;
            });

            tasks.set(entry.path, task);

            return task;
        };

        for (const entry of desired) {
            if (reasons.get(entry.path) === null) {
                statuses.set(entry.path, "kept");
            }
        }

        await Promise.allSettled(pending.map(taskOf));

        if (failure) {
            await this.save();

            throw failure.error;
        }

        report.push(...desired.map((entry) => ({ path: entry.path, status: statuses.get(entry.path)! })));

        await this.writeIgnore(kinds, scripts);
        await this.save();

        return report;
    }

    /**
     * The files that must be built before the entry: those of the operations a script is offered, since
     * it may run them and its verification runs list and locate, and, for a script that runs the project,
     * those of every operation and of the scripts before it, which are few and reviewed one at a time
     * anyway. A file that is only written waits for nothing.
     */
    private dependenciesOf(entry: SlytherArtifactBuilder["entry"], pending: SlytherArtifactBuilder["entry"][]): SlytherArtifactBuilder["entry"][] {
        if (!entry.script) {
            return [];
        }

        if (entry.owner.script) {
            return pending.slice(0, pending.indexOf(entry)).filter((other) => other.script !== undefined);
        }

        return pending.filter((other) => other.owner.operation !== undefined && entry.after!.includes(other.owner.operation));
    }

    /** Saves the manifest after every save asked for before, so saves made side by side land in order. */
    private save(): Promise<void> {
        this.saving = this.saving.catch(() => {}).then(() => this.manifest.save());

        return this.saving;
    }

    /** Records what the script at the path is doing now, and says what every script under way is doing. */
    private doing(path: string, doing: string): void {
        this.working.set(path, { doing, since: Date.now() });
        this.options.say?.(() => this.workingLabel());
    }

    /** Forgets the script at the path, which is no longer under way. */
    private done(path: string): void {
        this.working.delete(path);
        this.options.say?.(() => this.workingLabel());
    }

    /** Every script under way, longest waiting first, each with what it is doing and for how long. */
    private workingLabel(): string {
        const now = Date.now();
        const all = [...this.working]
            .sort(([, a], [, b]) => a.since - b.since)
            .map(([path, work]) => `${path}: ${work.doing} (${StringUtils.duration(now - work.since)})`);

        return all.length === 0 ? "building the artifacts" : all.length === 1 ? all[0]! : `${all.length} under way · ${all.join(" · ")}`;
    }

    /** Runs the work once everything asked to run exclusively before it is done, whether it passed or not. */
    private exclusively<T>(work: () => Promise<T>): Promise<T> {
        const result = this.locked.then(work);

        this.locked = result.then(
            () => {},
            () => {},
        );

        return result;
    }

    /** Up to the given number of holders at once; a slot released goes straight to the one waiting longest. */
    private static slots(size: number): { acquire: () => Promise<void>; release: () => void } {
        const waiting: (() => void)[] = [];
        let held = 0;

        return {
            acquire: async () => {
                if (held < size) {
                    held++;

                    return;
                }

                await new Promise<void>((resolve) => waiting.push(resolve));
            },
            release: () => {
                const next = waiting.shift();

                if (next) {
                    next();
                } else {
                    held--;
                }
            },
        };
    }

    /** Every file the kinds ask for, in the order they are built, along with the operation record each belongs to. */
    private desiredOf(kinds: SlytherArtifactKind[], parsed: ParsedSlytherScript): SlytherArtifactBuilder["entry"][] {
        const entries: SlytherArtifactBuilder["entry"][] = [];

        for (const kind of kinds) {
            const operations = SlytherArtifactBuilder.orderedOf(kind);

            for (const operation of operations) {
                const name = SlytherArtifactBuilder.shortOf(operation.artifact.name);
                const folder = join(SlytherArtifactKind.folderOf(kind.name), name);
                const record: SlytherArtifactManifest["operations"][string] = {
                    kind: kind.name,
                    name,
                    deterministic: operation.deterministic,
                    params: operation.params,
                    ...(operation.role ? { role: operation.role } : {}),
                    steps: [],
                };

                for (const step of operation.steps) {
                    const stepName = SlytherArtifactBuilder.shortOf(step.artifact.name);
                    const runtime = step.lang ? SlytherRuntime.of(step.lang, this.artifacts) : undefined;
                    const path = join(folder, `${stepName}.${runtime?.extension ?? "md"}`);
                    const run = runtime?.run(join(this.artifacts, path));
                    const inputHash = step.rule
                        ? SlytherArtifactBuilder.hash(
                              step.closureHash,
                              ...step.rule.negatives.map((negative) => negative.closureHash),
                              step.rule.owner?.scopeHash ?? "",
                              step.lang ?? "llm",
                              this.artifacts,
                              path,
                          )
                        : SlytherArtifactBuilder.hash(
                              step.closureHash,
                              operation.scopeHash,
                              runtime && (SlytherArtifactBuilder.READS.includes(name) || SlytherArtifactBuilder.rulesReferencedBy(kind, operation, step).length > 0) ? kind.guidanceHash : kind.rulesHash,
                              step.lang ?? "llm",
                              this.artifacts,
                              path,
                          );

                    record.steps.push({ name: stepName, kind: runtime ? "deterministic" : "llm", path, lang: step.lang, run, role: step.role, ...(step.rule ? { rule: step.rule.artifact.name } : {}) });
                    entries.push({
                        path,
                        inputHash,
                        owner: { operation: `${kind.name}::${name}`, record },
                        after: SlytherArtifactBuilder.offersOf(kind, name).map((other) => `${kind.name}::${other}`),
                        script: runtime
                            ? {
                                  runtime,
                                  cast: SlytherRole.cast(step.role ?? SlytherRole.WRITERS[0]!, this.roles),
                                  instructions: () =>
                                      step.rule
                                          ? this.ruleInstructionsOf(kind, step.rule, path, runtime)
                                          : this.instructionsOf(kinds, kind, operation, step, stepName, path, runtime, record),
                                  context: this.contextOf(parsed, kinds, kind, operation, step),
                                  verify: step.rule
                                      ? async () =>
                                            (await new SlytherVerifier(this.cwd).verify({ operation: name, script: join(this.artifacts, path), runtime })) ??
                                            this.reject(step.rule!, path, runtime)
                                      : () =>
                                      new SlytherVerifier(this.cwd).verify({
                                          operation: name,
                                          script: join(this.artifacts, path),
                                          runtime,
                                          params: operation.params.length,
                                          list: name === "list" ? undefined : this.builtScriptOf(kind.name, "list"),
                                          locate: name === "list" ? this.builtScriptOf(kind.name, "locate") : undefined,
                                          argsOf: SlytherArtifactBuilder.argsOfIn(kind, parsed),
                                          expand:
                                              name === SlytherArtifactKind.EXPAND
                                                  ? {
                                                        args: operation.params.map(() => SlytherVerifier.SAMPLE),
                                                        validate: (output) => SlytherArtifactBuilder.validateExpansion(kinds, kind, parsed, output),
                                                    }
                                                  : undefined,
                                      }),
                              }
                            : undefined,
                        content: runtime ? undefined : step.rule ? this.rulePromptOf(kind, step.rule, step.artifact.name) : this.promptOf(kind, operation, step),
                    });
                }

                if (!operation.deterministic) {
                    const path = join(folder, SlytherArtifactBuilder.ENTRY);

                    record.entry = path;
                    entries.push({
                        path,
                        inputHash: SlytherArtifactBuilder.hash(operation.closureHash, kind.rulesHash, ...record.steps.map((step) => `${step.kind} ${step.path}`), this.artifacts, path),
                        owner: { operation: `${kind.name}::${name}`, record },
                        content: this.entryOf(kind, operation, record),
                    });
                }
            }
        }

        return entries;
    }

    /**
     * Every file the scripts that run the project ask for: a script per step, built after every operation
     * so it may run them, checked for syntax and reviewed by the generator, since it may never exit.
     */
    private desiredOfScripts(kinds: SlytherArtifactKind[], scripts: SlytherRunScript[]): SlytherArtifactBuilder["entry"][] {
        const entries: SlytherArtifactBuilder["entry"][] = [];

        for (const script of scripts) {
            const record: SlytherArtifactManifest["scripts"][string] = { name: script.name, params: script.params, steps: [] };

            for (const step of script.steps) {
                const stepName = SlytherArtifactBuilder.shortOf(step.artifact.name);
                const runtime = SlytherRuntime.of(step.lang, this.artifacts);
                const path = join(SlytherArtifactBuilder.RUN, script.name, `${stepName}.${runtime.extension}`);
                let instructions = "";

                record.steps.push({ name: stepName, path, lang: step.lang, run: runtime.run(join(this.artifacts, path)) });
                entries.push({
                    path,
                    inputHash: SlytherArtifactBuilder.hash(step.closureHash, script.scopeHash, step.lang, this.artifacts, path),
                    owner: { script: script.name, record },
                    script: {
                        runtime,
                        cast: SlytherRole.cast(SlytherRole.WRITERS[0]!, this.roles),
                        instructions: () => (instructions = this.runInstructionsOf(script, step, stepName, path, runtime)),
                        context: script.references.map((artifact) => ({ path: `${artifact.artifact}:${artifact.name}`, content: artifact.textIn(this.cwd) })),
                        verify: async (content) => {
                            const syntax = await new SlytherVerifier(this.cwd).verify({ operation: SlytherArtifactBuilder.RUN, script: join(this.artifacts, path), runtime });

                            if (syntax !== null) {
                                return syntax;
                            }

                            const reviewer = SlytherRole.cast(SlytherRole.standardOf("judge"), this.roles);

                            this.doing(path, `asking the ${SlytherRole.labelOf(reviewer)} to review it`);

                            const review = await this.generator.review(instructions, [{ path, content }], reviewer);

                            return review.pass ? null : `${path} does not do what its instructions say:\n${review.errors.map((error) => `- ${error}`).join("\n")}`;
                        },
                    },
                });
            }
        }

        return entries;
    }

    /** Why the entry must be built: new, changed, missing or edited by hand. Null when it is up to date. */
    private async reasonToBuild(entry: SlytherArtifactBuilder["entry"]): Promise<string | null> {
        const recorded = this.manifest.files[entry.path];

        if (!recorded) {
            return "new";
        }

        if (recorded.inputHash !== entry.inputHash) {
            return "its source changed";
        }

        let content: string;

        try {
            content = await readFile(join(this.cwd, this.artifacts, entry.path), "utf-8");
        } catch {
            return "its file is missing";
        }

        return SlytherArtifactManifest.hashOf(content) === recorded.outputHash ? null : "it was edited by hand";
    }

    /** Generates the script of the entry, verifying and fixing it until it passes or the attempts run out. Returns how many fixes it took. */
    private async buildScript(entry: SlytherArtifactBuilder["entry"]): Promise<number> {
        const script = entry.script!;
        const attempts = this.options.attempts ?? SlytherArtifactBuilder.ATTEMPTS;

        const as = SlytherRole.labelOf(script.cast);

        this.doing(entry.path, `asking the ${as} (attempt 1 of ${attempts})`);

        let reply = await this.generator.generate({
            instructions: script.instructions(),
            context: script.context,
            expected: [entry.path],
            dependencies: this.manifest.dependenciesOf(script.runtime.lang),
            cast: script.cast,
        });

        for (let attempt = 1; ; attempt++) {
            const file = reply.files.find((file) => file.path === entry.path)!;

            await this.write(entry.path, file.content, entry.inputHash, reply.dependencies, SlytherRole.fingerprintOf(script.cast));

            this.doing(entry.path, "waiting for its turn to verify");

            const failure = await this.exclusively(async () => {
                await this.install(script.runtime, entry.path);
                this.doing(entry.path, "verifying");

                return script.verify(file.content);
            });

            if (failure === null) {
                return attempt - 1;
            }

            if (attempt >= attempts) {
                delete this.manifest.files[entry.path];
                await this.save();
                throw new Error(`${entry.path} failed verification ${attempt} times:\n${failure}`);
            }

            this.options.log?.(`${entry.path}: attempt ${attempt} failed verification:\n${failure.trim().split("\n").map((line) => `    ${line}`).join("\n")}`);
            this.doing(entry.path, `asking the ${as} to fix it (attempt ${attempt + 1} of ${attempts})`);
            reply = await this.generator.fix(reply.session, failure, [entry.path], script.cast);
        }
    }

    /** The single script of a deterministic operation of the kind, when it is built and on disk. */
    /** Whether the id alone locates an instance of the kind, so the ids list prints can be checked against it. */
    /**
     * The args an operation of the kind runs with for an id, as the check gives them: the id alone when it
     * is all the operation takes, else the args of the instance the project declares with that name, and
     * undefined when there is none, since nothing then says what the others are.
     */
    private static argsOfIn(kind: SlytherArtifactKind, parsed: ParsedSlytherScript): (operation: string, id: string) => string[] | undefined {
        const instances = new Map(parsed.artifacts.filter((artifact) => artifact.artifact === kind.name).map((artifact) => [artifact.name, artifact]));

        return (operation, id) => {
            const params = kind.operation(operation)?.params;

            if (params === undefined) {
                return undefined;
            }

            if (params.length === 1) {
                return [id];
            }

            const instance = instances.get(id);

            try {
                return instance && SlytherArtifactKind.argsOf({ kind: kind.name, name: operation, params }, { name: id, artifact: instance }, `${kind.name}:${id}`, []);
            } catch {
                return undefined;
            }
        };
    }

    private builtScriptOf(kind: string, operation: string): { script: string; runtime: SlytherRuntime } | undefined {
        const step = this.manifest.operations[`${kind}::${operation}`]?.steps[0];

        return step?.lang && this.manifest.files[step.path]
            ? { script: join(this.artifacts, step.path), runtime: SlytherRuntime.of(step.lang, this.artifacts) }
            : undefined;
    }

    /**
     * Writes the file and records it, so the manifest only ever describes what is on disk, along with who
     * wrote a script: a record of where it came from, which never makes it be written again.
     */
    private async write(path: string, content: string, inputHash: string, dependencies?: Record<string, string>, writtenBy?: string): Promise<void> {
        const target = join(this.cwd, this.artifacts, path);

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);

        this.manifest.files[path] = {
            inputHash,
            outputHash: SlytherArtifactManifest.hashOf(content),
            ...(dependencies && Object.keys(dependencies).length > 0 ? { dependencies } : {}),
            ...(writtenBy ? { writtenBy } : {}),
        };
    }

    /** Writes the dependencies file of the lang when its union changed, and installs it. */
    /** Installs the dependencies the scripts of the runtime ask for, when they changed, on behalf of the script at the path. */
    private async install(runtime: SlytherRuntime, path: string): Promise<void> {
        const content = runtime.dependencies(this.manifest.dependenciesOf(runtime.lang));
        const command = runtime.install();

        if (content === undefined || !runtime.dependenciesFile || !command || this.installed.get(runtime.lang) === content) {
            return;
        }

        const target = join(this.cwd, this.artifacts, runtime.dependenciesFile);
        const current = await readFile(target, "utf-8").catch(() => undefined);

        if (current !== content) {
            await writeFile(target, content);
        }

        const started = Date.now();

        this.doing(path, `installing the ${runtime.lang} dependencies (${command.join(" ")})`);

        const result = await ProcessUtils.run(command, { cwd: this.cwd });

        if (result.code !== 0) {
            throw new Error(`Installing the ${runtime.lang} dependencies failed:\n${result.stderr || result.stdout}`);
        }

        this.options.log?.(`installed the ${runtime.lang} dependencies (${StringUtils.duration(Date.now() - started)})`);
        this.installed.set(runtime.lang, content);
    }

    /** Ignores, inside the artifacts folder, whatever the runtimes in use create. */
    private async writeIgnore(kinds: SlytherArtifactKind[], scripts: SlytherRunScript[]): Promise<void> {
        const langs = new Set([
            ...kinds.flatMap((kind) => kind.operations.flatMap((operation) => operation.steps.map((step) => step.lang))),
            ...scripts.flatMap((script) => script.steps.map((step) => step.lang)),
        ]);
        const ignored = [...langs]
            .filter((lang): lang is string => lang !== undefined)
            .flatMap((lang) => SlytherRuntime.of(lang, this.artifacts).ignored)
            .sort();

        if (ignored.length === 0) {
            return;
        }

        await mkdir(join(this.cwd, this.artifacts), { recursive: true });
        await writeFile(join(this.cwd, this.artifacts, ".gitignore"), `${[...new Set(ignored)].map((dir) => `${dir}/`).join("\n")}\n`);
    }

    /**
     * Why what an expand printed for a sample instance is not accepted, or null when it is: it is read
     * as it will be at check time, into the parsed script with the sample instance declared.
     */
    private static validateExpansion(kinds: SlytherArtifactKind[], kind: SlytherArtifactKind, parsed: ParsedSlytherScript, output: string): string | null {
        const taken = new Set(parsed.artifacts.map((artifact) => artifact.name));
        let name = SlytherVerifier.SAMPLE;

        for (let index = 2; taken.has(name); index++) {
            name = `${SlytherVerifier.SAMPLE}${index}`;
        }

        const sample = new SlytherArtifact(kind.name, name, [], [], SlytherVerifier.SAMPLE, []);

        try {
            SlytherExpansion.of(output, sample, kinds, new ParsedSlytherScript([...parsed.artifacts, sample], new Map(), new Map(), parsed.lang));

            return null;
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    }

    /** What the generator is told to write a deterministic step. */
    private instructionsOf(
        kinds: SlytherArtifactKind[],
        kind: SlytherArtifactKind,
        operation: SlytherArtifactKind["operations"][number],
        step: SlytherArtifactKind["operations"][number]["steps"][number],
        stepName: string,
        path: string,
        runtime: SlytherRuntime,
        record: SlytherArtifactManifest["operations"][string],
    ): string {
        const others = SlytherArtifactBuilder.offersOf(kind, record.name)
            .map((name) => this.manifest.operations[`${kind.name}::${name}`])
            .filter((other): other is SlytherArtifactManifest["operations"][string] => other !== undefined && other.steps.every((step) => this.manifest.files[step.path]))
            .map(
                (other) =>
                    `- ${other.name}${SlytherArtifactBuilder.signatureOf(other.params)}: run ${other.steps
                        .map((step) => `\`${step.run!.join(" ")}${other.params.map((param) => ` <${param.name}>`).join("")}\``)
                        .join(" then ")}`,
            );

        return [
            `Write the script \`${path}\` in ${runtime.lang}: the step "${stepName}" of the operation "${record.name}" of the artifact kind "${kind.name}".`,
            "",
            `## Rules of every ${kind.name}`,
            "",
            this.rulesShownTo(kind, operation, step),
            "",
            `## Operation ${record.name}${SlytherArtifactBuilder.signatureOf(operation.params)}`,
            "",
            operation.artifact.textIn(this.cwd) || "(no further description)",
            "",
            `## Step ${stepName}`,
            "",
            step.artifact.textIn(this.cwd),
            "",
            "## Conventions",
            "",
            `- The script is run as \`${runtime.run(join(this.artifacts, path)).join(" ")}${operation.params.map((param) => ` <${param.name}>`).join("")}\`: it receives the params of the operation as positional arguments, in that order${operation.params.some((param) => param.optional) ? ", and an optional one may be absent" : ""}.`,
            "- It runs from the folder the code of the project lives in, so every path it reads or prints is relative to that folder.",
            "- It prints its result on stdout and its errors on stderr, never asks for input, and exits with the codes the operation describes: 0 on success and 1 when what it looks for does not exist, unless the operation says otherwise.",
            `- It is a single, self-contained file${runtime.lang === "ts" ? " run by bun, so it may use the Bun and node APIs" : ""}, importing only the dependencies it declares.`,
            ...SlytherArtifactBuilder.demandsOf(kind, operation.params),
            ...(others.length > 0
                ? ["- The operations of the kind built before this one are scripts it may run instead of reimplementing them, and none of them runs this one, so running one never comes back here:", ...others]
                : []),
            ...(record.name === SlytherArtifactKind.EXPAND ? ["", ...SlytherArtifactBuilder.emitsOf(kinds, kind, this.cwd)] : []),
        ].join("\n");
    }

    /** The rules of the kind the step or its operation reference, by name, which is what a script is shown instead of every rule. */
    private static rulesReferencedBy(
        kind: SlytherArtifactKind,
        operation: SlytherArtifactKind["operations"][number],
        step: SlytherArtifactKind["operations"][number]["steps"][number],
    ): SlytherArtifactKind["rules"] {
        const references = new Set([...operation.artifact.references, ...step.artifact.references]);

        return kind.rules.filter((rule) => references.has(`rule:${rule.artifact.name}`));
    }

    /**
     * What a script is shown of the rules of its kind: the guidance, and the rules it or its operation
     * reference, so editing another rule never rewrites it, or every rule when they reference none. A
     * script of an operation that reads an instance is shown the guidance alone: what it finds is not
     * what must be true of it.
     */
    private rulesShownTo(
        kind: SlytherArtifactKind,
        operation: SlytherArtifactKind["operations"][number],
        step: SlytherArtifactKind["operations"][number]["steps"][number],
    ): string {
        const referenced = SlytherArtifactBuilder.rulesReferencedBy(kind, operation, step);

        if (SlytherArtifactBuilder.READS.includes(SlytherArtifactBuilder.shortOf(operation.artifact.name))) {
            return kind.artifact.textIn(this.cwd);
        }

        if (referenced.length === 0) {
            return kind.rulesOf(this.cwd);
        }

        return [
            kind.artifact.textIn(this.cwd),
            ...referenced.flatMap((rule) => ["", `### Rule ${rule.artifact.name}`, "", rule.artifact.textIn(this.cwd)]),
        ]
            .join("\n")
            .trim();
    }

    /** What the generator is told to write the check of a rule: the rule, whoever owns it, and what it must reject. */
    private ruleInstructionsOf(kind: SlytherArtifactKind, rule: SlytherArtifactKind["rules"][number], path: string, runtime: SlytherRuntime): string {
        const owner = rule.owner?.artifact;

        return [
            `Write the script \`${path}\` in ${runtime.lang}: the check of the rule "${rule.artifact.name}" for every artifact of the kind "${kind.name}".`,
            "",
            ...(owner ? [`## ${owner.artifact === "artifact" ? `Every ${owner.name}` : `The trait ${owner.name}`}`, "", owner.textIn(this.cwd) || "(no further description)", ""] : []),
            `## Rule ${rule.artifact.name}`,
            "",
            rule.artifact.textIn(this.cwd),
            "",
            ...SlytherArtifactBuilder.section(SlytherArtifactBuilder.negativesOf(rule, this.cwd)),
            "## Conventions",
            "",
            `- The script is run as \`${runtime.run(join(this.artifacts, path)).join(" ")} <segment>...\`: it receives every segment of the ${kind.name} to check as positional arguments, each a path, for a whole file or folder, \`path:start-end\`, for the lines of a file from start to end, both inclusive and starting at 1, or \`path:line\`, for one line.`,
            "- It judges only what the segments hold: the rest of a file whose lines it is handed is context it may read, never what it checks, and it never looks for other files of the artifact on its own.",
            "- Several segments may point into one file. When the rule speaks of that file as a whole, of what it imports, exports or defines, the file is read once, whole, and judged once, never one segment at a time, since the segments only say which lines of it belong to the artifact.",
            `- The segments are every part of the ${kind.name}, and a rule usually speaks of some of them: it checks the segments the rule names, by their path or their name, and passes over the others without a word. A segment it is handed is never wrong for being there.`,
            "- A negative is a single file handed on its own, named as the rule names it, so what the rule says of that file is checked on it.",
            `- The args of the ${kind.name} are in its environment, one variable per param: ${["id", ...kind.params.map((param) => param.name)].map((name) => `\`${SlytherInstanceChecker.ENV}${name.toUpperCase().replace(/-/g, "_")}\``).join(", ")}${kind.params.length > 0 ? ", the value of each as the instance declares it, empty when it declares none" : ""}. They may all be absent, as when it is run against a sample, and then it judges what it can from the segments alone, never failing for an arg it was not given.`,
            "- It runs from the folder the code of the project lives in, so every path it reads is relative to that folder.",
            "- It exits 0 when every segment complies with the rule, and otherwise prints one line per discrepancy on stdout, each saying what is wrong and where, and exits 1. It never asks for input.",
            `- It is a single, self-contained file${runtime.lang === "ts" ? " run by bun, so it may use the Bun and node APIs" : ""}, importing only the dependencies it declares.`,
            "- It checks the rule as written and no more: what the rule does not say is not a discrepancy.",
        ].join("\n");
    }

    /** The markdown of the check of an llm rule: the rule, whoever owns it, what breaks it, and to judge that rule alone. */
    private rulePromptOf(kind: SlytherArtifactKind, rule: SlytherArtifactKind["rules"][number], name: string): string {
        const owner = rule.owner?.artifact;

        return [
            `# ${name}`,
            "",
            `Judge whether the ${kind.name} below complies with the rule "${rule.artifact.name}", and with that rule alone: what it does not say is not a discrepancy. Its code is every segment of the ${kind.name}, and the rule usually speaks of some of them: judge the ones it names and pass over the others.`,
            "",
            ...(owner ? [`## ${owner.artifact === "artifact" ? `Every ${owner.name}` : `The trait ${owner.name}`}`, "", owner.prose || "(no further description)", ""] : []),
            `## Rule ${rule.artifact.name}`,
            "",
            rule.artifact.prose,
            "",
            ...SlytherArtifactBuilder.section(SlytherArtifactBuilder.negativesOf(rule)),
        ].join("\n");
    }

    /** The negatives of a rule as instructions: each is code that breaks the rule, so the check must reject it. */
    private static negativesOf(rule: SlytherArtifactKind["rules"][number], cwd?: string): string[] {
        if (rule.negatives.length === 0) {
            return [];
        }

        return [
            "## What breaks it",
            "",
            "Each of these breaks the rule, so it must be found wanting:",
            ...rule.negatives.flatMap((negative) => ["", `### ${negative.artifact.name}`, "", cwd === undefined ? negative.artifact.prose : negative.artifact.textIn(cwd)]),
        ];
    }

    /**
     * Why the check of a rule accepts a negative, or null when it rejects every one: each is written to
     * a file of its own, the check is run with that file as the only segment, and must exit with a code
     * other than 0. The file holds the fenced code of the negative, named as its fence names it after
     * the lang, else with the extension the lang gives, or its whole prose when it holds no fence.
     */
    private async reject(rule: SlytherArtifactKind["rules"][number], path: string, runtime: SlytherRuntime): Promise<string | null> {
        const folder = join(this.artifacts, SlytherArtifactBuilder.NEGATIVES);

        try {
            for (const [index, negative] of rule.negatives.entries()) {
                const prose = negative.artifact.textIn(this.cwd);
                const fenced = SlytherArtifactBuilder.FENCED.exec(prose);
                const sample = fenced ? fenced[3]! : prose;
                const own = `${SlytherArtifactKind.folderOf(negative.artifact.name)}-${index}`;
                // A fence may name the file the negative is, so a check that looks for that name finds it.
                const file = fenced?.[2] ? join(folder, own, fenced[2]) : join(folder, `${own}.${fenced?.[1] || "txt"}`);

                await mkdir(dirname(join(this.cwd, file)), { recursive: true });
                await writeFile(join(this.cwd, file), sample);

                const result = await ProcessUtils.run([...runtime.run(join(this.artifacts, path)), file], { cwd: this.cwd, timeout: SlytherVerifier.TIMEOUT });

                if (result.code === 0) {
                    return `${join(this.artifacts, path)} accepts "${negative.artifact.name}", which breaks the rule "${rule.artifact.name}": it must exit 1 for a file holding:\n${sample}`;
                }
            }

            return null;
        } finally {
            await rm(join(this.cwd, folder), { recursive: true, force: true });
        }
    }

    /**
     * What whoever writes for a demanded kind is told about its demands: nothing declares an instance of
     * one, so the param is the whole of what the instance must do, and what it holds has to be said
     * outright rather than left to the rules of the kind to mention.
     */
    private static demandsOf(kind: SlytherArtifactKind, params: { name: string }[]): string[] {
        if (!kind.demanded || !params.some((param) => param.name === "demands")) {
            return [];
        }

        return [
            `- Nothing declares an instance of a ${kind.name}: it exists because the uses of another artifact named it. The param "demands" is what those artifacts ask of it, one \`member (kind:id)\` line per member: the member to provide, and the artifact that asked for it. It is the whole of what the instance must do, so the instance has exactly those members and no others.`,
        ];
    }

    /** What the script of an expand is told about what it prints: the form of a declaration and the kinds it may emit, with the args each of them takes. */
    private static emitsOf(kinds: SlytherArtifactKind[], kind: SlytherArtifactKind, cwd: string): string[] {
        const emitted = kind.emits.map((name) => kinds.find((candidate) => candidate.name === name)!);

        return [
            "## What it prints",
            "",
            `The declarations of the artifacts the ${kind.name} is made of, as they are written in a Slyther script, one per declaration: \`kind name (arg: "value", other: "value") { prose }\`, where the args are optional and the braces hold prose. The name is relative to the ${kind.name}: \`endpoint create\` printed for \`Users\` declares \`Users::create\`. The prose may reference another artifact as \`#{name}\`, and the ${kind.name} itself is always referenced, so the prose need not repeat what it says.`,
            "",
            "It may only declare the kinds below, each with the args or the prose its create needs: a param that is not given as an arg is filled with the prose, so a declaration without args must have prose. A kind takes only the args listed with it, and any other is an error.",
            ...emitted.flatMap((emitted) => {
                const needed = emitted.params;

                return [
                    "",
                    `### ${emitted.name}${needed.length > 0 ? `, which takes ${needed.map((param) => `${param.name} (${param.type}${param.optional ? ", optional" : ""})`).join(", ")}` : ", which takes no args"}`,
                    "",
                    emitted.rulesOf(cwd) || "(no rules)",
                ];
            }),
        ];
    }

    /** What the generator is told to write a step of a script that runs the project. */
    private runInstructionsOf(
        script: SlytherRunScript,
        step: SlytherRunScript["steps"][number],
        stepName: string,
        path: string,
        runtime: SlytherRuntime,
    ): string {
        const operations = Object.values(this.manifest.operations)
            .filter((operation) => operation.deterministic && operation.steps.every((step) => this.manifest.files[step.path]))
            .map(
                (operation) =>
                    `- ${operation.kind} ${operation.name}${SlytherArtifactBuilder.signatureOf(operation.params)}: run ${operation.steps
                        .map((step) => `\`${step.run!.join(" ")}${operation.params.map((param) => ` <${param.name}>`).join("")}\``)
                        .join(" then ")}`,
            );
        const own = script.steps.length > 1 || step.artifact.prose !== script.artifact.prose;

        return [
            `Write the script \`${path}\` in ${runtime.lang}: ${own ? `the step "${stepName}" of ` : ""}the script "${script.name}" that runs the project.`,
            "",
            `## Script ${script.name}${SlytherArtifactBuilder.signatureOf(script.params)}`,
            "",
            script.artifact.textIn(this.cwd) || "(no further description)",
            ...(own ? ["", `## Step ${stepName}`, "", step.artifact.textIn(this.cwd)] : []),
            "",
            "## Conventions",
            "",
            `- The script is run as \`${runtime.run(join(this.artifacts, path)).join(" ")}${script.params.map((param) => ` <${param.name}>`).join("")}\`: it receives the params of the script as positional arguments, in that order${script.params.some((param) => param.optional) ? ", and an optional one may be absent" : ""}.`,
            "- It runs from the folder the code of the project lives in, so every path it reads or prints is relative to that folder.",
            "- It runs in the terminal of whoever runs it, with their stdin, stdout and stderr, and may run for as long as the project does, like a server. It exits with 0 on success and with another code when it fails.",
            `- It is a single, self-contained file${runtime.lang === "ts" ? " run by bun, so it may use the Bun and node APIs" : ""}, importing only the dependencies it declares.`,
            ...(operations.length > 0 ? ["- The operations of the artifacts of the project are scripts it may run instead of reimplementing them:", ...operations] : []),
        ].join("\n");
    }

    /**
     * The prose the step, its operation and its kind reference, for the generator to read: the rules of
     * a kind, the prose of a rule or a trait, which the check of a rule references as any other, and
     * what an asset copies, so a rule held to the shape of an asset is written against it.
     */
    private contextOf(
        parsed: ParsedSlytherScript,
        kinds: SlytherArtifactKind[],
        kind: SlytherArtifactKind,
        operation: SlytherArtifactKind["operations"][number],
        step: SlytherArtifactKind["operations"][number]["steps"][number],
    ): { path: string; content: string }[] {
        const references = new Set([...kind.artifact.references, ...operation.artifact.references, ...step.artifact.references]);
        const context: { path: string; content: string }[] = [];

        for (const reference of references) {
            const boundary = reference.indexOf(":");
            const [artifact, name] = [reference.slice(0, boundary), reference.slice(boundary + 1)];

            if (artifact === "artifact") {
                const referenced = kinds.find((candidate) => candidate.name === name);

                if (referenced && referenced.name !== kind.name) {
                    context.push({ path: reference, content: referenced.rulesOf(this.cwd) });
                }
            } else if (artifact === "rule" || artifact === "trait" || artifact === "asset") {
                const referenced = parsed.artifacts.find((candidate) => candidate.artifact === artifact && candidate.name === name);

                if (referenced && referenced.name !== step.rule?.artifact.name) {
                    context.push({ path: reference, content: referenced.textIn(this.cwd) });
                }
            }
        }

        return context;
    }

    /** The markdown of an llm step: the rules of the kind and what the step asks for. */
    private promptOf(
        kind: SlytherArtifactKind,
        operation: SlytherArtifactKind["operations"][number],
        step: SlytherArtifactKind["operations"][number]["steps"][number],
    ): string {
        return [
            `# ${step.artifact.name}`,
            "",
            `Params: ${SlytherArtifactBuilder.paramsOf(operation.params)}`,
            "",
            ...SlytherArtifactBuilder.section(SlytherArtifactBuilder.demandsOf(kind, operation.params)),
            `## Rules of every ${kind.name}`,
            "",
            kind.rulesOf(),
            "",
            "## Step",
            "",
            step.artifact.prose,
            "",
        ].join("\n");
    }

    /** The markdown that orchestrates an operation that is not deterministic, step by step. */
    private entryOf(
        kind: SlytherArtifactKind,
        operation: SlytherArtifactKind["operations"][number],
        record: SlytherArtifactManifest["operations"][string],
    ): string {
        // An evaluate reports every discrepancy at once, so one fix sees them all; any other operation stops at the first failure.
        const failed = operation.artifact.name.endsWith("::evaluate") ? "note its output as discrepancies and go on" : "stop and report its output";
        const steps = record.steps.map((step, index) =>
            step.run
                ? `${index + 1}. Run \`${step.run.join(" ")}${record.params.map((param) => ` "{${param.name}}"`).join("")}\`. If it exits with a code other than 0, ${failed}.`
                : `${index + 1}. Follow \`${join(this.artifacts, step.path)}\`.`,
        );

        return [
            `# ${operation.artifact.name}`,
            "",
            `Params: ${SlytherArtifactBuilder.paramsOf(record.params)}`,
            "",
            ...SlytherArtifactBuilder.section(SlytherArtifactBuilder.demandsOf(kind, record.params)),
            ...(operation.artifact.prose ? [operation.artifact.prose, ""] : []),
            `## Rules of every ${kind.name}`,
            "",
            kind.rulesOf(),
            "",
            "## Steps",
            "",
            "Follow these in order, with the params substituted where they appear in braces:",
            "",
            ...steps,
            "",
        ].join("\n");
    }

    private async prune(dir: string): Promise<void> {
        const base = join(this.cwd, this.artifacts);

        for (let current = dir; current.startsWith(base) && current !== base; current = dirname(current)) {
            if ((await readdir(current).catch(() => ["."])).length > 0) {
                return;
            }

            await rmdir(current);
        }
    }

    /** The operations of the kind in the order they are built, so a script is only ever offered the ones built before it. */
    /**
     * The operations of the kind a step of the named one is offered to run, which are also what it waits
     * for: the deterministic ones built before it, save that signature and uses are never offered each other.
     */
    private static offersOf(kind: SlytherArtifactKind, name: string): string[] {
        const order = SlytherArtifactBuilder.orderedOf(kind);
        const rank = order.findIndex((operation) => SlytherArtifactBuilder.shortOf(operation.artifact.name) === name);

        return order
            .slice(0, Math.max(rank, 0))
            .filter((operation) => operation.deterministic)
            .map((operation) => SlytherArtifactBuilder.shortOf(operation.artifact.name))
            .filter((other) => !(SlytherArtifactBuilder.PEERS.includes(name) && SlytherArtifactBuilder.PEERS.includes(other)));
    }

    private static orderedOf(kind: SlytherArtifactKind): SlytherArtifactKind["operations"] {
        return [...kind.operations].sort(
            (a, b) => SlytherArtifactBuilder.rankOf(a.artifact.name) - SlytherArtifactBuilder.rankOf(b.artifact.name),
        );
    }

    private static rankOf(name: string): number {
        const index = SlytherArtifactBuilder.FIRST.indexOf(SlytherArtifactBuilder.shortOf(name));

        return index < 0 ? SlytherArtifactBuilder.FIRST.length : index;
    }

    private static shortOf(name: string): string {
        return name.slice(name.lastIndexOf("::") + 2);
    }

    private static signatureOf(params: { name: string; type: string; optional: boolean }[]): string {
        return ` (${params.map((param) => `${param.name}: ${param.type}${param.optional ? "?" : ""}`).join(", ")})`;
    }

    /** The lines followed by a blank one, or nothing at all when there are none. */
    private static section(lines: string[]): string[] {
        return lines.length === 0 ? [] : [...lines, ""];
    }

    private static paramsOf(params: { name: string; type: string; optional: boolean }[]): string {
        return params.length === 0 ? "none" : params.map((param) => `${param.name} (${param.type}${param.optional ? ", optional" : ""})`).join(", ");
    }

    private static hash(...parts: string[]): string {
        return createHash("sha256").update(parts.join("\n")).digest("hex");
    }

    /** A file the build wants on disk, and what it takes to write it. */
    private declare readonly entry: {
        path: string;
        inputHash: string;
        /** The operation, keyed `kind::name`, or the script, keyed by its name, the file belongs to, and its record. */
        owner: {
            operation?: string;
            script?: string;
            record: SlytherArtifactManifest["operations"][string] | SlytherArtifactManifest["scripts"][string];
        };
        /** The operations, keyed `kind::name`, a deterministic step is offered, so it is written once they are built. */
        after?: string[];
        /** Set for a deterministic step, which the generator writes once the operations before it are built. */
        script?: {
            runtime: SlytherRuntime;
            /** The role that writes the script, and who plays it. */
            cast: SlytherRole["cast"];
            /** Computed when the script is written, since they name what is built by then. */
            instructions: () => string;
            context: { path: string; content: string }[];
            /** Why the script as written fails, or null when it passes. */
            verify: (content: string) => Promise<string | null>;
        };
        /** Set for a markdown, which Slyther writes itself. */
        content?: string;
    };
}
