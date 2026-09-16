// Imports
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export class SlytherProject {
    /** The entry point of a project, relative to its root. */
    static readonly MAIN = "main.sly";
    /** Where the Slyther output files live, relative to the root. */
    static readonly OUTPUT = ".slyther";

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
