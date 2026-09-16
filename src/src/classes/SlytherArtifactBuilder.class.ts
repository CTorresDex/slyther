// Imports
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProcessUtils } from "./ProcessUtils.class.ts";
import { SlytherArtifactManifest } from "./SlytherArtifactManifest.class.ts";
import type { SlytherArtifactKind } from "./SlytherArtifactKind.class.ts";
import type { SlytherGenerator } from "./SlytherGenerator.class.ts";
import { SlytherRuntime } from "./SlytherRuntime.class.ts";
import { SlytherVerifier } from "./SlytherVerifier.class.ts";

export class SlytherArtifactBuilder {
    /** How many times a script that fails verification is sent back to be fixed before the build fails. */
    static readonly ATTEMPTS = 3;
    /** The name of the markdown that orchestrates an operation that is not deterministic. */
    private static readonly ENTRY = "operation.md";
    /** The operations built first, since the others may call them. */
    private static readonly FIRST = ["locate", "list", "signature", "uses"];

    private manifest!: SlytherArtifactManifest;
    private installed = new Map<string, string>();

    constructor(
        /** The folder the code of the project lives in, where every script runs. */
        private readonly cwd: string,
        /** The folder the artifacts are built into, relative to where the scripts run. */
        private readonly artifacts: string,
        private readonly generator: SlytherGenerator,
        private readonly options: { attempts?: number; log?: (line: string) => void } = {},
    ) {}

    /**
     * Brings the artifacts folder in line with the kinds: writes what is new or changed, removes what
     * is gone, and leaves alone what is up to date. Returns what it did to every file, and throws when a
     * script cannot be made to pass verification.
     */
    async build(kinds: SlytherArtifactKind[]): Promise<{ path: string; status: "built" | "rebuilt" | "kept" | "removed" }[]> {
        this.manifest = await SlytherArtifactManifest.load(join(this.cwd, this.artifacts, SlytherArtifactManifest.FILE));
        this.installed = new Map();

        const desired = this.desiredOf(kinds);
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
            if (!desired.some((entry) => `${entry.kind}::${entry.operation}` === key)) {
                delete this.manifest.operations[key];
            }
        }

        for (const entry of desired) {
            const reason = await this.reasonToBuild(entry);

            this.manifest.operations[`${entry.kind}::${entry.operation}`] = entry.record;

            if (reason === null) {
                report.push({ path: entry.path, status: "kept" });
                continue;
            }

            this.options.log?.(`${entry.path}: ${reason}`);
            await (entry.script ? this.buildScript(entry) : this.write(entry.path, entry.content!, entry.inputHash));
            await this.manifest.save();
            report.push({ path: entry.path, status: reason === "new" ? "built" : "rebuilt" });
        }

        await this.writeIgnore(kinds);
        await this.manifest.save();

        return report;
    }

    /** Every file the kinds ask for, in the order they are built, along with the operation record each belongs to. */
    private desiredOf(kinds: SlytherArtifactKind[]): SlytherArtifactBuilder["entry"][] {
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
                        kind: kind.name,
                        operation: name,
                        path,
                        inputHash,
                        record,
                        script: runtime ? { runtime, operation: name, kind, step, stepName, kinds } : undefined,
                        content: runtime ? undefined : this.promptOf(kind, operation, step),
                    });
                }

                if (!operation.deterministic) {
                    const path = join(folder, SlytherArtifactBuilder.ENTRY);

                    record.entry = path;
                    entries.push({
                        kind: kind.name,
                        operation: name,
                        path,
                        inputHash: SlytherArtifactBuilder.hash(operation.closureHash, kind.scopeHash, this.artifacts, path),
                        record,
                        content: this.entryOf(kind, operation, record),
                    });
                }
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

    /** Generates the script of the entry, verifying and fixing it until it passes or the attempts run out. */
    private async buildScript(entry: SlytherArtifactBuilder["entry"]): Promise<void> {
        const script = entry.script!;
        const operation = script.kind.operations.find((candidate) => SlytherArtifactBuilder.shortOf(candidate.artifact.name) === script.operation)!;
        let reply = await this.generator.generate({
            instructions: this.instructionsOf(script.kind, operation, script.step, script.stepName, entry.path, script.runtime, entry.record),
            context: this.contextOf(script.kinds, script.kind, operation, script.step),
            expected: [entry.path],
            dependencies: this.manifest.dependenciesOf(script.runtime.lang),
        });

        for (let attempt = 1; ; attempt++) {
            const file = reply.files.find((file) => file.path === entry.path)!;

            await this.write(entry.path, file.content, entry.inputHash, reply.dependencies);
            await this.install(script.runtime);

            const failure = await new SlytherVerifier(this.cwd).verify({
                operation: script.operation,
                script: join(this.artifacts, entry.path),
                runtime: script.runtime,
                list: script.operation === "list" ? undefined : this.builtScriptOf(entry.kind, "list"),
                locate: script.operation === "list" ? this.builtScriptOf(entry.kind, "locate") : undefined,
            });

            if (failure === null) {
                return;
            }

            if (attempt >= (this.options.attempts ?? SlytherArtifactBuilder.ATTEMPTS)) {
                delete this.manifest.files[entry.path];
                await this.manifest.save();
                throw new Error(`${entry.path} failed verification ${attempt} times:\n${failure}`);
            }

            this.options.log?.(`${entry.path}: attempt ${attempt} failed, fixing`);
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

        this.options.log?.(`installing the ${runtime.lang} dependencies`);

        const result = await ProcessUtils.run(command, { cwd: this.cwd });

        if (result.code !== 0) {
            throw new Error(`Installing the ${runtime.lang} dependencies failed:\n${result.stderr || result.stdout}`);
        }

        this.installed.set(runtime.lang, content);
    }

    /** Ignores, inside the artifacts folder, whatever the runtimes in use create. */
    private async writeIgnore(kinds: SlytherArtifactKind[]): Promise<void> {
        const langs = new Set(kinds.flatMap((kind) => kind.operations.flatMap((operation) => operation.steps.map((step) => step.lang))));
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

    /** What the generator is told to write a deterministic step. */
    private instructionsOf(
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
        kind: string;
        operation: string;
        path: string;
        inputHash: string;
        record: SlytherArtifactManifest["operations"][string];
        /** Set for a deterministic step, which the generator writes once the operations before it are built. */
        script?: {
            runtime: SlytherRuntime;
            operation: string;
            kind: SlytherArtifactKind;
            step: SlytherArtifactKind["operations"][number]["steps"][number];
            stepName: string;
            kinds: SlytherArtifactKind[];
        };
        /** Set for a markdown, which Slyther writes itself. */
        content?: string;
    };
}
