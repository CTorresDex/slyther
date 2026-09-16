// Imports
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ParsedSlytherScript } from "./ParsedSlytherScript.class.ts";
import { SlytherParser } from "./SlytherParser.class.ts";
import { SlytherScript } from "./SlytherScript.class.ts";

export class SlytherProject {
    /** The entry point of a project, relative to its root. */
    static readonly MAIN = "main.sly";
    /** Where the Slyther output files live, relative to the root. */
    static readonly OUTPUT = ".slyther";
    /** Where the build writes its files, relative to the output folder. */
    static readonly BUILD = "build";

    constructor(
        /** The folder the slyther files live in. */
        readonly root: string,
    ) {}

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

    /** Builds the project, returning the paths it wrote. */
    async build(): Promise<string[]> {
        return [(await this.parse()).path];
    }

    /** Parses the entry point and writes its JSON representation to the build folder as parser.json. */
    async parse(): Promise<{ parsed: ParsedSlytherScript; path: string }> {
        const parsed = new SlytherParser().parse(await SlytherScript.of(this.main));
        const path = join(this.buildDir, "parser.json");

        await mkdir(this.buildDir, { recursive: true });
        await writeFile(path, JSON.stringify(parsed, null, 4));

        return { parsed, path };
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

        return { project, created };
    }

    private static async exists(path: string): Promise<boolean> {
        return stat(path).then(
            () => true,
            () => false,
        );
    }
}
