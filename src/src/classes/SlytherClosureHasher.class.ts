// Imports
import { createHash } from "node:crypto";
import type { SlytherArtifact } from "./SlytherArtifact.class.ts";

export class SlytherClosureHasher {
    private artifacts = new Map<string, SlytherArtifact>();
    private indexes = new Map<string, number>();
    private lowLinks = new Map<string, number>();
    private groups = new Map<string, number>();
    private digests = new Map<number, string>();
    private stack: string[] = [];
    private stacked = new Set<string>();
    private visited = 0;

    hash(artifacts: SlytherArtifact[]): Map<string, string> {
        this.artifacts = new Map(
            artifacts.map((artifact) => [`${artifact.artifact}:${artifact.name}`, artifact]),
        );
        this.indexes = new Map();
        this.lowLinks = new Map();
        this.groups = new Map();
        this.digests = new Map();
        this.stack = [];
        this.stacked = new Set();
        this.visited = 0;

        for (const key of this.artifacts.keys()) {
            if (!this.indexes.has(key)) {
                this.visit(key);
            }
        }

        return new Map(
            [...this.artifacts].map(([key, artifact]) => [
                key,
                createHash("sha256")
                    .update([artifact.hash, this.digests.get(this.groups.get(key)!)].join("\n"))
                    .digest("hex"),
            ]),
        );
    }

    private visit(key: string): void {
        this.indexes.set(key, this.visited);
        this.lowLinks.set(key, this.visited);
        this.visited++;
        this.stack.push(key);
        this.stacked.add(key);

        for (const reference of this.referencesOf(key)) {
            if (!this.indexes.has(reference)) {
                this.visit(reference);
                this.lowLinks.set(
                    key,
                    Math.min(this.lowLinks.get(key)!, this.lowLinks.get(reference)!),
                );
            } else if (this.stacked.has(reference)) {
                this.lowLinks.set(
                    key,
                    Math.min(this.lowLinks.get(key)!, this.indexes.get(reference)!),
                );
            }
        }

        if (this.lowLinks.get(key) !== this.indexes.get(key)) {
            return;
        }

        const members: string[] = [];
        let member: string | undefined;

        do {
            member = this.stack.pop()!;
            this.stacked.delete(member);
            members.push(member);
        } while (member !== key);

        this.close(members);
    }

    private close(members: string[]): void {
        const group = this.digests.size;
        const inside = new Set(members);

        for (const member of members) {
            this.groups.set(member, group);
        }

        const outside = new Set<string>();

        for (const member of members) {
            for (const reference of this.referencesOf(member)) {
                if (!inside.has(reference)) {
                    outside.add(this.digests.get(this.groups.get(reference)!)!);
                }
            }
        }

        const digest = createHash("sha256")
            .update(
                [
                    members.map((member) => `${member}@${this.artifacts.get(member)!.hash}`).sort(),
                    [...outside].sort(),
                ]
                    .map((lines) => lines.join("\n"))
                    .join("\n--\n"),
            )
            .digest("hex");

        this.digests.set(group, digest);
    }

    private referencesOf(key: string): string[] {
        return (this.artifacts.get(key)?.references ?? []).filter((reference) =>
            this.artifacts.has(reference),
        );
    }
}
