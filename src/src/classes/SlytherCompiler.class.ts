// Imports
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ClaudeCLI } from "./ClaudeCLI.class.ts";
import type { SlytherArtifactKind } from "./SlytherArtifactKind.class.ts";
import { SlytherManifest } from "./SlytherManifest.class.ts";
import { SlytherSkill } from "./SlytherSkill.class.ts";

export class SlytherCompiler {
    /** Where the scripts and the manifest go, relative to the project root. */
    static readonly OUTPUT = ".slyther";
    /** Where the skills go, relative to the project root: one copy per agent that reads them. */
    static readonly SKILLS = [".claude/skills", ".codex/skills"];
    /** The script language of a deterministic step that names none. */
    private static readonly LANGUAGE = "sh";
    /** What a script must satisfy in each language. */
    private static readonly CONTRACTS: Record<string, string> = {
        sh: "POSIX sh: start with `#!/bin/sh` and `set -eu`, use no bashisms, and rely only on POSIX tools (sed, awk, grep, find).",
        ts: "TypeScript run by Bun: start with `#!/usr/bin/env bun`, use only the Node and Bun standard libraries, and read the arguments from `process.argv.slice(2)`.",
    };

    constructor(
        /** The project root every path is relative to. */
        private readonly root: string,
        private readonly claude: ClaudeCLI,
        /** Where to report each file as it is settled. */
        private readonly report: (line: string) => void = () => {},
    ) {}

    /**
     * Compiles the kinds: generates a script for every deterministic step and a description for every
     * operation through the Claude CLI, unless the manifest already holds one generated from the same
     * hash, then renders a skill for every operation once every script of the kind is settled, so the
     * evaluation loop of one skill can name the scripts of another. Kinds without operations are left alone.
     */
    async compile(kinds: SlytherArtifactKind[]): Promise<{ generated: number; reused: number; skills: number }> {
        const manifest = await SlytherManifest.load(join(this.root, SlytherCompiler.OUTPUT, "compiled.json"));
        const outcome = { generated: 0, reused: 0, skills: 0 };
        const scripts: string[] = [];
        const descriptions: string[] = [];

        for (const kind of kinds) {
            const instructions = new Map<string, string>();
            const described = new Map<string, string>();

            for (const operation of kind.operations) {
                for (const step of operation.steps) {
                    if (step.artifact.artifact !== "deterministic") {
                        continue;
                    }

                    const path = this.pathOf(kind, operation, step);
                    const hash = this.hashOf(kind.artifact.hash, step.closureHash);
                    const remembered = manifest.get("scripts", path, hash);

                    scripts.push(path);

                    if (remembered !== undefined && (await Bun.file(join(this.root, path)).exists())) {
                        outcome.reused++;
                        instructions.set(step.artifact.name, remembered.replace("{{script}}", this.invocationOf(path)));
                        continue;
                    }

                    const written = await this.claude.askJSON<{ script: string; instruction: string }>(
                        this.scriptPrompt(kind, operation, step),
                    );

                    if (typeof written.script !== "string" || typeof written.instruction !== "string") {
                        throw new Error(`The script of ${step.artifact.name} came back without a script or an instruction.`);
                    }

                    await this.write(path, written.script.endsWith("\n") ? written.script : `${written.script}\n`);
                    await chmod(join(this.root, path), 0o755);
                    manifest.set("scripts", path, hash, written.instruction);
                    instructions.set(step.artifact.name, written.instruction.replace("{{script}}", this.invocationOf(path)));
                    outcome.generated++;
                    this.report(`generated ${path}`);
                }

                const hash = this.hashOf(kind.artifact.hash, operation.closureHash);
                let description = manifest.get("descriptions", operation.artifact.name, hash);

                descriptions.push(operation.artifact.name);

                if (description === undefined) {
                    description = (await this.claude.ask(this.descriptionPrompt(kind, operation))).trim().replace(/\s+/g, " ");
                    manifest.set("descriptions", operation.artifact.name, hash, description);
                    outcome.generated++;
                    this.report(`described ${operation.artifact.name}`);
                } else {
                    outcome.reused++;
                }

                described.set(operation.artifact.name, description);
            }

            for (const operation of kind.operations) {
                const skill = new SlytherSkill(kind, operation, described.get(operation.artifact.name)!, instructions);

                for (const directory of SlytherCompiler.SKILLS) {
                    const path = join(directory, skill.name, "SKILL.md");

                    await this.write(path, skill.render());
                    outcome.skills++;
                    this.report(`wrote ${path}`);
                }
            }
        }

        manifest.keep("scripts", scripts);
        manifest.keep("descriptions", descriptions);
        await manifest.save();

        return outcome;
    }

    /** Where the script of a step lives: `.slyther/artifacts/{kind}/{operation}/{step}.{lang}`. */
    private pathOf(
        kind: SlytherArtifactKind,
        operation: SlytherArtifactKind["operations"][number],
        step: SlytherArtifactKind["operations"][number]["steps"][number],
    ): string {
        const segments = step.artifact.name.split("::");

        return join(SlytherCompiler.OUTPUT, "artifacts", kind.name, segments[segments.length - 2]!, `${segments[segments.length - 1]}.${this.languageOf(step)}`);
    }

    /** How a script is run from the project root. */
    private invocationOf(path: string): string {
        return path.endsWith(".ts") ? `bun ${path}` : path;
    }

    private languageOf(step: SlytherArtifactKind["operations"][number]["steps"][number]): string {
        const language = step.artifact.args.find((arg) => arg.name === "lang");
        const name = language ? String(language.value) : SlytherCompiler.LANGUAGE;

        if (!(name in SlytherCompiler.CONTRACTS)) {
            throw new Error(`Unknown script language "${name}" of ${step.artifact.name}.`);
        }

        return name;
    }

    private hashOf(...parts: string[]): string {
        return createHash("sha256").update(parts.join("\n")).digest("hex");
    }

    private async write(path: string, content: string): Promise<void> {
        await mkdir(dirname(join(this.root, path)), { recursive: true });
        await writeFile(join(this.root, path), content);
    }

    private scriptPrompt(
        kind: SlytherArtifactKind,
        operation: SlytherArtifactKind["operations"][number],
        step: SlytherArtifactKind["operations"][number]["steps"][number],
    ): string {
        const language = this.languageOf(step);
        const name = step.artifact.name.slice(step.artifact.name.lastIndexOf("::") + 2);
        const short = operation.artifact.name.slice(operation.artifact.name.lastIndexOf("::") + 2);

        return [
            `You are writing the deterministic step "${name}" of the "${short}" operation of the "${kind.name}" artifact kind of a project.`,
            `Every ${kind.name} of the project follows these rules:`,
            kind.rules,
            "The step must do exactly this, no more and no less:",
            step.artifact.content,
            `Write it as a script in ${SlytherCompiler.CONTRACTS[language]}`,
            "The script runs from the project root, reads its input only from its command-line arguments, assumes nothing about the project beyond what the rules say, prints to stdout only what the step says to print, reports errors on stderr, exits 0 on success and 1 on any failure.",
            'Reply with one JSON object and nothing else, no code fence: {"script": "<the full script>", "instruction": "<one sentence telling an agent how to run it>"}.',
            "The instruction is written as `Run {{script}} <args>`, keeps {{script}} verbatim as the placeholder for the path, and names each argument and what it is.",
        ].join("\n\n");
    }

    private descriptionPrompt(kind: SlytherArtifactKind, operation: SlytherArtifactKind["operations"][number]): string {
        const short = operation.artifact.name.slice(operation.artifact.name.lastIndexOf("::") + 2);
        const steps = operation.steps.map((step) => `- ${step.artifact.artifact}: ${step.artifact.content}`).join("\n");

        return [
            `Describe in one sentence what the "${short}" operation of the "${kind.name}" artifact kind does, for the description an agent reads when picking a skill from a list. Say what it takes as input and what it produces.`,
            `Every ${kind.name} of the project follows these rules:`,
            kind.rules,
            "The operation runs these steps in order:",
            steps,
            "Reply with the sentence only.",
        ].join("\n\n");
    }
}
