// Imports
import { join } from "node:path";

export class SlytherRuntime {
    /** The langs a deterministic step may be written in, and how each one is run. */
    private static readonly ALL: Record<
        string,
        {
            extension: string;
            run: (script: string, artifacts: string) => string[];
            check: (script: string, artifacts: string) => string[];
            dependencies?: { file: string; content: (dependencies: Record<string, string>) => string };
            install?: (artifacts: string) => string[];
            ignored: string[];
        }
    > = {
        ts: {
            extension: "ts",
            run: (script) => ["bun", script],
            check: (script) => ["bun", "build", script, "--no-bundle"],
            dependencies: {
                file: "package.json",
                content: (dependencies) => `${JSON.stringify({ private: true, dependencies }, null, 4)}\n`,
            },
            install: (artifacts) => ["bun", "install", "--cwd", artifacts],
            ignored: ["node_modules"],
        },
        py: {
            extension: "py",
            run: (script, artifacts) => [SlytherRuntime.python(artifacts), script],
            check: (script, artifacts) => [SlytherRuntime.python(artifacts), "-m", "py_compile", script],
            dependencies: {
                file: "requirements.txt",
                content: (dependencies) =>
                    Object.entries(dependencies)
                        .map(([name, version]) => `${name}==${version}\n`)
                        .join(""),
            },
            install: (artifacts) => [
                "sh",
                "-c",
                `[ -d "${join(artifacts, ".venv")}" ] || python3 -m venv "${join(artifacts, ".venv")}"; "${SlytherRuntime.python(artifacts)}" -m pip install -q -r "${join(artifacts, "requirements.txt")}"`,
            ],
            ignored: [".venv"],
        },
        sh: {
            extension: "sh",
            run: (script) => ["sh", script],
            check: (script) => ["sh", "-n", script],
            ignored: [],
        },
    };

    private constructor(
        /** The lang the runtime runs. */
        readonly lang: string,
        /** The folder the artifacts are built into, relative to the root of the project. */
        private readonly artifacts: string,
        private readonly definition: (typeof SlytherRuntime.ALL)[string],
    ) {}

    /** The runtime of the lang, throwing when it is not one Slyther knows. */
    static of(lang: string, artifacts: string): SlytherRuntime {
        const definition = SlytherRuntime.ALL[lang];

        if (!definition) {
            throw new Error(`Unknown lang "${lang}": the langs are ${SlytherRuntime.langs.join(", ")}.`);
        }

        return new SlytherRuntime(lang, artifacts, definition);
    }

    /** The langs Slyther knows. */
    static get langs(): string[] {
        return Object.keys(SlytherRuntime.ALL);
    }

    /** The extension of a script of the lang. */
    get extension(): string {
        return this.definition.extension;
    }

    /** The folders the runtime creates that never belong in version control. */
    get ignored(): string[] {
        return this.definition.ignored;
    }

    /** The file the dependencies of every step of the lang are declared in, relative to the artifacts folder. */
    get dependenciesFile(): string | undefined {
        return this.definition.dependencies?.file;
    }

    /** The command that runs the script, given relative to the root of the project, from that root. */
    run(script: string): string[] {
        return this.definition.run(script, this.artifacts);
    }

    /** The command that checks the syntax of the script without running it. */
    check(script: string): string[] {
        return this.definition.check(script, this.artifacts);
    }

    /** The content of the dependencies file for the given `name: version` map. */
    dependencies(dependencies: Record<string, string>): string | undefined {
        return this.definition.dependencies?.content(dependencies);
    }

    /** The command that installs the declared dependencies, if the lang has any. */
    install(): string[] | undefined {
        return this.definition.install?.(this.artifacts);
    }

    private static python(artifacts: string): string {
        return join(artifacts, ".venv", "bin", "python");
    }
}
