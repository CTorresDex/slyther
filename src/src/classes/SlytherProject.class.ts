// Imports
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherArtifactBuilder } from "./SlytherArtifactBuilder.class.ts";
import { SlytherArtifactKind } from "./SlytherArtifactKind.class.ts";
import { SlytherArtifactManifest } from "./SlytherArtifactManifest.class.ts";
import type { SlytherGenerator } from "./SlytherGenerator.class.ts";
import { SlytherInstanceChecker } from "./SlytherInstanceChecker.class.ts";
import { SlytherInstanceManifest } from "./SlytherInstanceManifest.class.ts";
import { SlytherParser } from "./SlytherParser.class.ts";
import { SlytherProviders } from "./SlytherProviders.class.ts";
import { SlytherRole } from "./SlytherRole.class.ts";
import { SlytherRunScript } from "./SlytherRunScript.class.ts";
import { SlytherScript } from "./SlytherScript.class.ts";
import { SlytherTracedGenerator } from "./SlytherTracedGenerator.class.ts";

export class SlytherProject {
    /** The entry point of a project, relative to its root. */
    static readonly MAIN = "main.sly";
    /** Where the Slyther output files live, relative to the root. */
    static readonly OUTPUT = ".slyther";
    /** Where the build writes its files, relative to the output folder. */
    static readonly BUILD = "build";
    /** Where the code of the project lives and runs from, relative to the output folder. */
    static readonly SOURCE = "src";
    /** Where the operations of every kind are built into, relative to the output folder. */
    static readonly ARTIFACTS = "artifacts";
    /** Where what the check found about every artifact is recorded, relative to the output folder. */
    static readonly INSTANCES = "instances";
    /** What every alias of a role resolved to the last build, in the build folder, to say when it resolves to another. */
    static readonly PINNED = "roles.json";

    /** What writes the scripts of the deterministic steps, traced when the project is verbose. */
    private readonly generator: SlytherGenerator;
    /** Where the build reports what it does, as plain functions so they can be handed around and spread. */
    private readonly progress: { log: (line: string) => void; say: (label: string | (() => string)) => void };

    constructor(
        /** The folder the slyther files live in. */
        readonly root: string,
        generator: SlytherGenerator = new SlytherProviders(),
        /** Where the build reports what it does: log prints a finished line, say names what it is waiting on. */
        progress: { log: (line: string) => void; say: (label: string | (() => string)) => void } = { log: () => {}, say: () => {} },
        /** verbose: every prompt sent to the llm and every reply are logged. */
        options: { verbose?: boolean } = {},
    ) {
        this.progress = { log: (line) => progress.log(line), say: (label) => progress.say(label) };
        this.generator = options.verbose ? new SlytherTracedGenerator(generator, this.progress.log) : generator;
    }

    /** The path of the entry point. */
    get main(): string {
        return join(this.root, SlytherProject.MAIN);
    }

    /** The path of the folder of output files. */
    get output(): string {
        return join(this.root, SlytherProject.OUTPUT);
    }

    /** The path of the folder the build writes to. */
    get buildDir(): string {
        return join(this.output, SlytherProject.BUILD);
    }

    /**
     * The path of the folder the code of the project lives in. Everything that runs code runs from it, so
     * a script that reads `./` reads this folder, not the root.
     */
    get src(): string {
        return join(this.output, SlytherProject.SOURCE);
    }

    /** The folder the operations are built into, relative to the source folder, where they run from. */
    get artifactsDir(): string {
        return join("..", SlytherProject.ARTIFACTS);
    }

    /**
     * Compiles the project: parses it, builds the operations of its kinds, then brings every instance
     * its scripts declare in line with its declaration, creating what is missing, updating what is
     * outdated or fails, and evaluating it, up to fixes times. Returns what it did to every file and to
     * every instance.
     */
    async build(options: { max?: number; fixes?: number } = {}): Promise<{
        files: { path: string; status: "built" | "rebuilt" | "kept" | "removed" }[];
        instances: Awaited<ReturnType<SlytherProject["checkInstances"]>>;
    }> {
        const { parsed: declared, path } = await this.parse();
        const parsed = await this.cast(declared);
        const files = [{ path, status: "built" as const }, ...(await this.buildArtifacts(parsed))];

        return { files, instances: await this.checkInstances(parsed, { ...options, compile: true }) };
    }

    /** Parses the entry point and writes its JSON representation to the build folder as parser.json. */
    async parse(): Promise<{ parsed: ParsedSlytherScript; path: string }> {
        const parsed = new SlytherParser().parse(await SlytherScript.of(this.main), this.src);
        const path = join(this.buildDir, "parser.json");

        await mkdir(this.buildDir, { recursive: true });
        await writeFile(path, JSON.stringify(parsed, null, 4));

        return { parsed, path };
    }

    /**
     * Builds the operations of every kind and the scripts that run the project into the artifacts folder, where a manifest remembers the
     * hash each file was built from and the hash it was written with, so only what is new, changed,
     * missing or edited by hand is built again, and what is gone is removed.
     */
    async buildArtifacts(parsed: ParsedSlytherScript): Promise<{ path: string; status: "built" | "rebuilt" | "kept" | "removed" }[]> {
        const kinds = SlytherArtifactKind.of(parsed);

        for (const kind of kinds) {
            for (const warning of kind.warnings) {
                this.progress.log(`warning: ${warning}`);
            }
        }


        await mkdir(this.src, { recursive: true });

        const report = await new SlytherArtifactBuilder(this.src, this.artifactsDir, this.generator, this.progress).build(
            kinds,
            SlytherRunScript.of(parsed),
            parsed,
        );

        return report.map((entry) => ({ ...entry, path: join(this.src, this.artifactsDir, entry.path) }));
    }

    /**
     * Makes sure every role the work of the project asks for is played before any of it is asked for, and
     * says which roles are played by the standard role of their line because nobody plays them: the roles
     * of every step and every operation of the kinds, and the ones that write and review the scripts that
     * run the project. Throws with every problem at once. Then pins who plays each of them, as the
     * generator resolves it now, and says what every alias resolved to, and when it no longer resolves to
     * what it did the build before. Returns the parsed script with the roles pinned, which is what every
     * call of the build asks with and what is recorded.
     */
    private async cast(parsed: ParsedSlytherScript): Promise<ParsedSlytherScript> {
        const kinds = SlytherArtifactKind.of(parsed);
        const roles = new Set<string>();

        for (const operation of kinds.flatMap((kind) => kind.operations)) {
            for (const role of [operation.role, ...operation.steps.map((step) => step.role)]) {
                if (role !== undefined) {
                    roles.add(role);
                }
            }
        }

        if (SlytherRunScript.of(parsed).length > 0) {
            roles.add(SlytherRole.WRITERS[0]!);
            roles.add(SlytherRole.standardOf("judge"));
        }

        const casts = [...roles].map((role) => SlytherRole.cast(role, parsed.roles));
        const problems = this.generator.problemsWith(casts);

        if (problems.length > 0) {
            throw new Error(problems.join("\n"));
        }

        for (const cast of casts) {
            if (cast.by && cast.by.role !== cast.role) {
                this.progress.log(`warning: nobody plays the ${cast.role}, so the ${cast.by.role} does: bind it with @role ${cast.role} to choose who does.`);
            }
        }

        const named = [...new Set(casts.flatMap((cast) => (cast.by ? [cast.by.role] : [])))];
        const pinned = await this.generator.pinRoles(parsed.roles, named);
        const path = join(this.buildDir, SlytherProject.PINNED);
        const before: Record<string, string> = JSON.parse(await readFile(path, "utf-8").catch(() => "{}"));
        const now: Record<string, string> = {};

        for (const role of named) {
            const asked = parsed.roles.get(role)!;

            for (const [option, value] of Object.entries(pinned.get(role)!.options)) {
                const original = asked.options[option];

                if (original === undefined || original === value) {
                    continue;
                }

                const key = `${asked.provider} ${option}=${original}`;
                const was = before[key];
                const judges = SlytherRole.lineOf(role) === "judge";

                now[key] = value;
                this.progress.log(
                    was !== undefined && was !== value
                        ? `${role}: "${original}" now resolves to ${value}, no longer ${was}, so ${judges ? "what it judged is evaluated again" : "what it writes from now on is written by it"}`
                        : `${role}: "${original}" resolves to ${value}`,
                );
            }
        }

        await mkdir(this.buildDir, { recursive: true });
        await writeFile(path, `${JSON.stringify({ ...before, ...now }, null, 4)}\n`);

        return new ParsedSlytherScript(parsed.artifacts, parsed.closureHashes, parsed.scopeHashes, parsed.lang, parsed.packages, pinned);
    }

    /**
     * Builds the operations of the kinds, then checks every instance its scripts declare against its
     * declaration and the rules of its kind, evaluating again only what changed and touching no code.
     * Returns what happened to every instance.
     */
    async check(options: { max?: number } = {}): Promise<Awaited<ReturnType<SlytherProject["checkInstances"]>>> {
        const parsed = await this.cast((await this.parse()).parsed);

        await this.buildArtifacts(parsed);

        return this.checkInstances(parsed, { ...options, compile: false });
    }

    /**
     * Checks every instance the parsed script declares whose kind has operations with the operations as
     * built, recording what it finds in the instances folder so the next check evaluates only what
     * changed. With compile, it also creates what is missing and updates what is outdated or fails, the
     * latter up to fixes times.
     */
    async checkInstances(parsed: ParsedSlytherScript, options: { compile?: boolean; max?: number; fixes?: number } = {}): Promise<SlytherInstanceChecker["entry"][]> {
        const built = await SlytherArtifactManifest.load(join(this.src, this.artifactsDir, SlytherArtifactManifest.FILE));
        await mkdir(this.src, { recursive: true });

        const checker = new SlytherInstanceChecker(
            this.src,
            this.artifactsDir,
            join(this.output, SlytherProject.INSTANCES, SlytherInstanceManifest.FILE),
            built,
            this.generator,
            { ...options, ...this.progress },
        );

        return checker.check(parsed, SlytherArtifactKind.of(parsed));
    }

    /**
     * Runs a script of the project as built, `default` unless named: its steps run in order from the source
     * folder in the terminal, with the args as positional arguments, stopping at the first that fails.
     * Returns the exit code of the last step it ran.
     */
    async run(name: string = SlytherParser.RUN_DEFAULT, args: string[] = []): Promise<number> {
        const manifest = await SlytherArtifactManifest.load(join(this.src, this.artifactsDir, SlytherArtifactManifest.FILE));
        const record = manifest.scripts[name];

        if (!record) {
            const built = Object.keys(manifest.scripts);

            throw new Error(
                `The script "${name}" is not built: run build first, or check the name.${built.length > 0 ? ` The scripts built are ${built.join(", ")}.` : ""}`,
            );
        }

        SlytherProject.checkArgs(`The script "${name}"`, record.params, args);
        await mkdir(this.src, { recursive: true });

        for (const step of record.steps) {
            const process = Bun.spawn([...step.run, ...args], { cwd: this.src, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
            const code = await process.exited;

            if (code !== 0) {
                return code;
            }
        }

        return 0;
    }

    /** The names of the scripts that run the project, as built. */
    async scripts(): Promise<string[]> {
        const manifest = await SlytherArtifactManifest.load(join(this.src, this.artifactsDir, SlytherArtifactManifest.FILE));

        return Object.keys(manifest.scripts);
    }

    /**
     * Runs an operation as built: a deterministic one runs its scripts in order from the source folder and
     * stops at the first that fails, one that is not prints the markdown that orchestrates it with the
     * params substituted, or runs it through the generator when one is given to execute it with.
     */
    async runOperation(
        kind: string,
        operation: string,
        args: string[],
        options: { execute?: SlytherGenerator } = {},
    ): Promise<{ code: number; output: string }> {
        const manifest = await SlytherArtifactManifest.load(join(this.src, this.artifactsDir, SlytherArtifactManifest.FILE));
        const record = manifest.operations[`${kind}::${operation}`];

        if (!record) {
            throw new Error(`The operation "${kind}::${operation}" is not built: run build first, or check the name.`);
        }

        SlytherProject.checkArgs(`The operation "${kind}::${operation}"`, record.params, args);

        await mkdir(this.src, { recursive: true });

        if (record.deterministic) {
            for (const step of record.steps) {
                // The check of a rule takes the segments of the instance, which locate prints given the params it takes.
                const handed = step.rule ? await this.segmentsOf(manifest, kind, record.params, args) : args;

                if (handed === undefined) {
                    return { code: 1, output: "" };
                }

                const env = step.rule ? Object.fromEntries(record.params.map((param, index) => [`${SlytherInstanceChecker.ENV}${param.name.toUpperCase().replace(/-/g, "_")}`, args[index] ?? ""])) : {};
                const process = Bun.spawn([...step.run!, ...handed], { cwd: this.src, stdout: "inherit", stderr: "inherit", env: { ...Bun.env, ...env } });
                const code = await process.exited;

                if (code !== 0) {
                    return { code, output: "" };
                }
            }

            return { code: 0, output: "" };
        }

        let markdown = await readFile(join(this.src, this.artifactsDir, record.entry!), "utf-8");

        record.params.forEach((param, index) => {
            markdown = markdown.replaceAll(`{${param.name}}`, args[index] ?? "");
        });

        if (!options.execute) {
            return { code: 0, output: markdown };
        }

        const role = record.role ?? SlytherRole.standardOf("write");
        const { roles } = (await this.parse()).parsed;
        const asked = SlytherRole.cast(role, roles);
        const problems = options.execute.problemsWith([asked]);

        if (problems.length > 0) {
            throw new Error(problems.join("\n"));
        }

        const cast = SlytherRole.cast(role, await options.execute.pinRoles(roles, asked.by ? [asked.by.role] : []));

        return { code: 0, output: (await options.execute.execute(markdown, this.src, undefined, cast)).text };
    }

    /**
     * The segments locate prints for an instance, given the args of an operation and its params, from
     * which locate is handed the ones it takes by name, or undefined when locate finds nothing.
     */
    private async segmentsOf(manifest: SlytherArtifactManifest, kind: string, params: { name: string }[], args: string[]): Promise<string[] | undefined> {
        const locate = manifest.operations[`${kind}::locate`];

        if (!locate) {
            throw new Error(`The locate of "${kind}" is not built: run build first.`);
        }

        const handed = locate.params.map((param) => args[params.findIndex((candidate) => candidate.name === param.name)] ?? "");
        let stdout = "";

        for (const step of locate.steps) {
            const process = Bun.spawn([...step.run!, ...handed], { cwd: this.src, stdout: "pipe", stderr: "inherit" });

            stdout = await new Response(process.stdout).text();

            if ((await process.exited) !== 0) {
                return undefined;
            }
        }

        return stdout.split("\n").filter((line) => line.trim().length > 0);
    }

    /**
     * Initializes a project in the given folder, creating whatever part of its structure is missing and
     * never touching what already exists. Returns the project and the paths it created.
     */
    static async init(root: string = process.cwd()): Promise<{ project: SlytherProject; created: string[] }> {
        const project = new SlytherProject(resolve(root));
        const created: string[] = [];

        if (!(await SlytherProject.exists(project.main))) {
            await writeFile(project.main, "", { flag: "wx" });
            created.push(project.main);
        }

        if (!(await SlytherProject.exists(project.output))) {
            await mkdir(project.output, { recursive: true });
            created.push(project.output);
        }

        if (!(await SlytherProject.exists(project.src))) {
            await mkdir(project.src, { recursive: true });
            created.push(project.src);
        }

        return { project, created };
    }

    /** Throws when the args do not fit the params: too few for the required ones, or more than there are. */
    private static checkArgs(what: string, params: { name: string; type: string; optional: boolean }[], args: string[]): void {
        const required = params.filter((param) => !param.optional).length;

        if (args.length < required || args.length > params.length) {
            throw new Error(
                `${what} takes (${params.map((param) => `${param.name}: ${param.type}${param.optional ? "?" : ""}`).join(", ")}), not ${args.length} argument${args.length === 1 ? "" : "s"}.`,
            );
        }
    }

    private static async exists(path: string): Promise<boolean> {
        return stat(path).then(
            () => true,
            () => false,
        );
    }
}
