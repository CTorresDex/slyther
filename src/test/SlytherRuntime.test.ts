import { describe, expect, test } from "bun:test";
import { SlytherRuntime } from "../src/classes/SlytherRuntime.class.ts";

const ARTIFACTS = ".slyther/artifacts";

describe("SlytherRuntime", () => {
    test("ts runs and checks with bun and declares dependencies in a package.json", () => {
        const runtime = SlytherRuntime.of("ts", ARTIFACTS);

        expect(runtime.extension).toBe("ts");
        expect(runtime.run(".slyther/artifacts/k/locate/locate.ts")).toEqual(["bun", ".slyther/artifacts/k/locate/locate.ts"]);
        expect(runtime.check("x.ts")).toEqual(["bun", "build", "x.ts", "--no-bundle"]);
        expect(runtime.dependenciesFile).toBe("package.json");
        expect(JSON.parse(runtime.dependencies({ "web-tree-sitter": "0.25.3" })!)).toEqual({
            private: true,
            dependencies: { "web-tree-sitter": "0.25.3" },
        });
        expect(runtime.install()).toEqual(["bun", "install", "--cwd", ARTIFACTS]);
        expect(runtime.ignored).toEqual(["node_modules"]);
    });

    test("py runs with the python of the venv of the artifacts folder", () => {
        const runtime = SlytherRuntime.of("py", ARTIFACTS);

        expect(runtime.run("x.py")).toEqual([".slyther/artifacts/.venv/bin/python", "x.py"]);
        expect(runtime.check("x.py")).toEqual([".slyther/artifacts/.venv/bin/python", "-m", "py_compile", "x.py"]);
        expect(runtime.dependencies({ black: "24.1.0", ruff: "0.4.0" })).toBe("black==24.1.0\nruff==0.4.0\n");
        expect(runtime.install()![0]).toBe("sh");
        expect(runtime.ignored).toEqual([".venv", "__pycache__"]);
    });

    test("sh has no dependencies", () => {
        const runtime = SlytherRuntime.of("sh", ARTIFACTS);

        expect(runtime.run("x.sh")).toEqual(["sh", "x.sh"]);
        expect(runtime.check("x.sh")).toEqual(["sh", "-n", "x.sh"]);
        expect(runtime.dependenciesFile).toBeUndefined();
        expect(runtime.dependencies({})).toBeUndefined();
        expect(runtime.install()).toBeUndefined();
    });

    test("throws on an unknown lang", () => {
        expect(() => SlytherRuntime.of("rs", ARTIFACTS)).toThrow('Unknown lang "rs": the langs are ts, py, sh.');
    });
});
