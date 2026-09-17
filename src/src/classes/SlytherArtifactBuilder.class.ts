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
import type { SlytherRunScript } from "./SlytherRunScript.class.ts";
import { SlytherRuntime } from "./SlytherRuntime.class.ts";
import { SlytherVerifier } from "./SlytherVerifier.class.ts";
import { StringUtils } from "./StringUtils.class.ts";

export class SlytherArtifactBuilder {
    /** How many times a script that fails verification is sent back to be fixed before the build fails. */
    static readonly ATTEMPTS = 3;
    /** The name of the markdown that orchestrates an operation that is not deterministic. */
    private static readonly ENTRY = "operation.md";
    /** The operations built first, since the others may call them. */
    private static readonly FIRST = ["locate", "list", "signature", "uses"];
    /** The folder the scripts that run the project are built into, a name no kind can take. */
    static readonly RUN = "@run";

    private manifest!: SlytherArtifactManifest;
    private installed = new Map<string, string>();

    constructor(
        /** The folder the code of the project lives in, where every script runs. */
        private readonly cwd: string,
        /** The folder the artifacts are built into, relative to where the scripts run. */
        private readonly artifacts: string,
        private readonly generator: SlytherGenerator,
        /** attempts: how many times a script may be fixed; log: prints a finished line; say: names what is being waited on. */
        private readonly options: { attempts?: number; log?: (line: string) => void; say?: (label: string) => void } = {},
    ) {}

    /**
     * Brings the artifacts folder in line with the kinds and the scripts that run the project: writes what
     * is new or changed, removes what is gone, and leaves alone what is up to date. Returns what it did to
     * every file, and throws when a script cannot be made to pass verification. The parsed script the
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

        for (const entry of desired) {
            const reason = reasons.get(entry.path)!;

            if (entry.owner.operation) {
                this.manifest.operations[entry.owner.operation] = entry.owner.record as SlytherArtifactManifest["operations"][string];
            } else {
                this.manifest.scripts[entry.owner.script!] = entry.owner.record as SlytherArtifactManifest["scripts"][string];
            }

            if (reason === null) {
                report.push({ path: entry.path, status: "kept" });
                continue;
            }

            const started = Date.now();
            const status = reason === "new" ? "built" : "rebuilt";

            this.options.say?.(`${entry.path}: writing`);

            const fixes = entry.script ? await this.buildScript(entry) : (await this.write(entry.path, entry.content!, entry.inputHash), 0);

            await this.manifest.save();
            this.options.log?.(`${status} ${entry.path}: ${reason} (${StringUtils.duration(Date.now() - started)}${fixes > 0 ? `, ${fixes} fix${fixes === 1 ? "" : "es"}` : ""})`);
            report.push({ path: entry.path, status });
        }

        await this.writeIgnore(kinds, scripts);
        await this.manifest.save();

        return report;
    }

    /** Every file the kinds ask for, in the order they are built, along with the operation record each belongs to. */
    private desiredOf(kinds: SlytherArtifactKind[], parsed: ParsedSlytherScript): SlytherArtifactBuilder["entry"][] {
        const entries: SlytherArtifactBuilder["entry"][] = [];

        for (const kind of kinds) {
            const operations = [...kind.operations].sort(
                (a, b) => SlytherArtifactBuilder.rankOf(a.artifact.name) - SlytherArtifactBuilder.rankOf(b.artifact.name),
            );

            for (const operation of operations) {
                const name = SlytherArtifactBuilder.shortOf(operation.artifact.name);
                const folder = join(kind.name, name);
                const record: SlytherArtifactManifest["operations"][string] = {
                    kind: kind.name,
                    name,
                    deterministic: operation.deterministic,
                    params: operation.params,
                    steps: [],
                };

                for (const step of operation.steps) {
                    const stepName = SlytherArtifactBuilder.shortOf(step.artifact.name);
                    const runtime = step.lang ? SlytherRuntime.of(step.lang, this.artifacts) : undefined;
                    const path = join(folder, `${stepName}.${runtime?.extension ?? "md"}`);
                    const run = runtime?.run(join(this.artifacts, path));
                    const inputHash = SlytherArtifactBuilder.hash(step.closureHash, operation.scopeHash, kind.scopeHash, step.lang ?? "llm", this.artifacts, path);

                    record.steps.push({ name: stepName, kind: runtime ? "deterministic" : "llm", path, lang: step.lang, run });
                    entries.push({
                        path,
                        inputHash,
                        owner: { operation: `${kind.name}::${name}`, record },
                        script: runtime
                            ? {
                                  runtime,
                                  instructions: () => this.instructionsOf(kinds, kind, operation, step, stepName, path, runtime, record),
                                  context: this.contextOf(kinds, kind, operation, step),
                                  verify: () =>
                                      new SlytherVerifier(this.cwd).verify({
                                          operation: name,
                                          script: join(this.artifacts, path),
                                          runtime,
                                          list: name === "list" ? undefined : this.builtScriptOf(kind.name, "list"),
                                          locate: name === "list" ? this.builtScriptOf(kind.name, "locate") : undefined,
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
                        content: runtime ? undefined : this.promptOf(kind, operation, step),
                    });
                }

                if (!operation.deterministic) {
                    const path = join(folder, SlytherArtifactBuilder.ENTRY);

                    record.entry = path;
                    entries.push({
                        path,
                        inputHash: SlytherArtifactBuilder.hash(operation.closureHash, kind.scopeHash, this.artifacts, path),
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
                        instructions: () => (instructions = this.runInstructionsOf(script, step, stepName, path, runtime)),
                        context: script.references.map((artifact) => ({ path: `${artifact.artifact}:${artifact.name}`, content: artifact.content })),
                        verify: async (content) => {
                            const syntax = await new SlytherVerifier(this.cwd).verify({ operation: SlytherArtifactBuilder.RUN, script: join(this.artifacts, path), runtime });

                            if (syntax !== null) {
                                return syntax;
                            }

                            this.options.say?.(`${path}: asking the llm to review it`);

                            const review = await this.generator.review(instructions, [{ path, content }]);

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

        this.options.say?.(`${entry.path}: asking the llm (attempt 1 of ${attempts})`);

        let reply = await this.generator.generate({
            instructions: script.instructions(),
            context: script.context,
            expected: [entry.path],
            dependencies: this.manifest.dependenciesOf(script.runtime.lang),
        });

        for (let attempt = 1; ; attempt++) {
            const file = reply.files.find((file) => file.path === entry.path)!;

            await this.write(entry.path, file.content, entry.inputHash, reply.dependencies);
            await this.install(script.runtime);
            this.options.say?.(`${entry.path}: verifying`);

            const failure = await script.verify(file.content);

            if (failure === null) {
                return attempt - 1;
            }

            if (attempt >= attempts) {
                delete this.manifest.files[entry.path];
                await this.manifest.save();
                throw new Error(`${entry.path} failed verification ${attempt} times:\n${failure}`);
            }

            this.options.log?.(`${entry.path}: attempt ${attempt} failed verification:\n${failure.trim().split("\n").map((line) => `    ${line}`).join("\n")}`);
            this.options.say?.(`${entry.path}: asking the llm to fix it (attempt ${attempt + 1} of ${attempts})`);
            reply = await this.generator.fix(reply.session, failure, [entry.path]);
        }
    }

    /** The single script of a deterministic operation of the kind, when it is built and on disk. */
    private builtScriptOf(kind: string, operation: string): { script: string; runtime: SlytherRuntime } | undefined {
        const step = this.manifest.operations[`${kind}::${operation}`]?.steps[0];

        return step?.lang && this.manifest.files[step.path]
            ? { script: join(this.artifacts, step.path), runtime: SlytherRuntime.of(step.lang, this.artifacts) }
            : undefined;
    }

    /** Writes the file and records it, so the manifest only ever describes what is on disk. */
    private async write(path: string, content: string, inputHash: string, dependencies?: Record<string, string>): Promise<void> {
        const target = join(this.cwd, this.artifacts, path);

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);

        this.manifest.files[path] = {
            inputHash,
            outputHash: SlytherArtifactManifest.hashOf(content),
            ...(dependencies && Object.keys(dependencies).length > 0 ? { dependencies } : {}),
        };
    }

    /** Writes the dependencies file of the lang when its union changed, and installs it. */
    private async install(runtime: SlytherRuntime): Promise<void> {
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

        this.options.say?.(`installing the ${runtime.lang} dependencies (${command.join(" ")})`);

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
        const others = Object.values(this.manifest.operations)
            .filter(
                (other) =>
                    other.kind === kind.name &&
                    other.name !== record.name &&
                    other.deterministic &&
                    other.steps.every((step) => this.manifest.files[step.path]),
            )
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
            kind.rules,
            "",
            `## Operation ${record.name}${SlytherArtifactBuilder.signatureOf(operation.params)}`,
            "",
            operation.artifact.content || "(no further description)",
            "",
            `## Step ${stepName}`,
            "",
            step.artifact.content,
            "",
            "## Conventions",
            "",
            `- The script is run as \`${runtime.run(join(this.artifacts, path)).join(" ")}${operation.params.map((param) => ` <${param.name}>`).join("")}\`: it receives the params of the operation as positional arguments, in that order${operation.params.some((param) => param.optional) ? ", and an optional one may be absent" : ""}.`,
            "- It runs from the folder the code of the project lives in, so every path it reads or prints is relative to that folder.",
            "- It prints its result on stdout and its errors on stderr, never asks for input, and exits with the codes the operation describes: 0 on success and 1 when what it looks for does not exist, unless the operation says otherwise.",
            `- It is a single, self-contained file${runtime.lang === "ts" ? " run by bun, so it may use the Bun and node APIs" : ""}, importing only the dependencies it declares.`,
            ...(others.length > 0
                ? ["- The other operations of the kind are scripts it may run instead of reimplementing them:", ...others]
                : []),
            ...(record.name === SlytherArtifactKind.EXPAND ? ["", ...SlytherArtifactBuilder.emitsOf(kinds, kind)] : []),
        ].join("\n");
    }

    /** What the script of an expand is told about what it prints: the form of a declaration and the kinds it may emit, with what their create needs. */
    private static emitsOf(kinds: SlytherArtifactKind[], kind: SlytherArtifactKind): string[] {
        const emitted = kind.emits.map((name) => kinds.find((candidate) => candidate.name === name)!);

        return [
            "## What it prints",
            "",
            `The declarations of the artifacts the ${kind.name} is made of, as they are written in a Slyther script, one per declaration: \`kind name (arg: "value", other: "value") { prose }\`, where the args are optional and the braces hold prose. The name is relative to the ${kind.name}: \`endpoint create\` printed for \`Users\` declares \`Users::create\`. The prose may reference another artifact as \`#{name}\`, and the ${kind.name} itself is always referenced, so the prose need not repeat what it says.`,
            "",
            "It may only declare the kinds below, each with the args or the prose its create needs: a param of create that is not given as an arg is filled with the prose, so a declaration without args must have prose.",
            ...emitted.flatMap((emitted) => {
                const create = emitted.operation("create");
                const needed = (create?.params ?? []).filter((param) => param.name !== "id" && param.name !== "errors");

                return [
                    "",
                    `### ${emitted.name}${needed.length > 0 ? `, whose create needs ${needed.map((param) => `${param.name} (${param.type}${param.optional ? ", optional" : ""})`).join(", ")}` : ""}`,
                    "",
                    emitted.rules || "(no rules)",
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
        const own = script.steps.length > 1 || step.artifact.content !== script.artifact.content;

        return [
            `Write the script \`${path}\` in ${runtime.lang}: ${own ? `the step "${stepName}" of ` : ""}the script "${script.name}" that runs the project.`,
            "",
            `## Script ${script.name}${SlytherArtifactBuilder.signatureOf(script.params)}`,
            "",
            script.artifact.content || "(no further description)",
            ...(own ? ["", `## Step ${stepName}`, "", step.artifact.content] : []),
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

    /** The prose the step, its operation and its kind reference, for the generator to read. */
    private contextOf(
        kinds: SlytherArtifactKind[],
        kind: SlytherArtifactKind,
        operation: SlytherArtifactKind["operations"][number],
        step: SlytherArtifactKind["operations"][number]["steps"][number],
    ): { path: string; content: string }[] {
        const references = new Set([...kind.artifact.references, ...operation.artifact.references, ...step.artifact.references]);
        const context: { path: string; content: string }[] = [];

        for (const reference of references) {
            const [, name] = reference.split(":") as [string, string];
            const referenced = kinds.find((candidate) => candidate.name === name)?.artifact;

            if (referenced && referenced.name !== kind.name) {
                context.push({ path: reference, content: referenced.content });
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
            `## Rules of every ${kind.name}`,
            "",
            kind.rules,
            "",
            "## Step",
            "",
            step.artifact.content,
            "",
        ].join("\n");
    }

    /** The markdown that orchestrates an operation that is not deterministic, step by step. */
    private entryOf(
        kind: SlytherArtifactKind,
        operation: SlytherArtifactKind["operations"][number],
        record: SlytherArtifactManifest["operations"][string],
    ): string {
        const steps = record.steps.map((step, index) =>
            step.run
                ? `${index + 1}. Run \`${step.run.join(" ")}${record.params.map((param) => ` "{${param.name}}"`).join("")}\`. If it exits with a code other than 0, stop and report its output.`
                : `${index + 1}. Follow \`${join(this.artifacts, step.path)}\`.`,
        );

        return [
            `# ${operation.artifact.name}`,
            "",
            `Params: ${SlytherArtifactBuilder.paramsOf(record.params)}`,
            "",
            ...(operation.artifact.content ? [operation.artifact.content, ""] : []),
            `## Rules of every ${kind.name}`,
            "",
            kind.rules,
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
        /** Set for a deterministic step, which the generator writes once the operations before it are built. */
        script?: {
            runtime: SlytherRuntime;
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
