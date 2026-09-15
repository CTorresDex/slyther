// Imports
import { readFile } from "node:fs/promises";

export class SlytherScript {
    constructor(
        readonly source: string,
        readonly path: string = "",
    ) {}

    /** The script written at the given path, so its imports resolve relative to it. */
    static async of(path: string): Promise<SlytherScript> {
        return new SlytherScript(await readFile(path, "utf-8"), path);
    }
}
