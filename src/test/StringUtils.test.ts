import { describe, expect, test } from "bun:test";
import { StringUtils } from "../src/classes/StringUtils.class.ts";

describe("StringUtils.diff", () => {
    test("gives nothing when the texts are the same", () => {
        expect(StringUtils.diff("a\nb", "a\nb")).toEqual([]);
    });

    test("marks what only one of them holds and keeps what both do as context", () => {
        expect(StringUtils.diff("a\nb\nc", "a\nB\nc")).toEqual(["  a", "- b", "+ B", "  c"]);
    });

    test("collapses every run of unchanged lines farther than the context from a change", () => {
        const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "old"].join("\n");
        const after = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "new"].join("\n");

        expect(StringUtils.diff(before, after)).toEqual(["  ...", "  7", "  8", "  9", "- old", "+ new"]);
    });

    test("marks what a text only adds and what it only takes away", () => {
        expect(StringUtils.diff("a", "a\nb")).toEqual(["  a", "+ b"]);
        expect(StringUtils.diff("a\nb", "a")).toEqual(["  a", "- b"]);
        expect(StringUtils.diff("", "a")).toEqual(["- ", "+ a"]);
    });
});
