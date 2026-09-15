import { readFile } from "fs/promises";
import { SlytherParser } from "./src/classes/SlytherParser.class.ts";
import { SlytherScript } from "./src/classes/SlytherScript.class.ts";


async function main() {
    const file = await readFile("./main.sly", "utf8");
    const parser = new SlytherParser();
    const script = new SlytherScript(file);
    const parsed = parser.parse(script);

    console.log(parsed);
}

main();