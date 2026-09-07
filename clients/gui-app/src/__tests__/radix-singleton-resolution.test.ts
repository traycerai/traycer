/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Radix internals (`focus-scope`, `dismissable-layer`, `focus-guards`) share module-scoped state. Two copies silently misbehave. Assert the resolved graph, not declarations: vaul or an override can fork `@radix-ui/react-dialog` underneath the monolith. */
const LOCKFILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "bun.lock",
);

const SINGLETON_PACKAGES = [
  "@radix-ui/react-focus-scope",
  "@radix-ui/react-dismissable-layer",
  "@radix-ui/react-focus-guards",
] as const;

describe("Radix module-scoped singletons", () => {
  const lockfile = readFileSync(LOCKFILE, "utf8");

  it.each(SINGLETON_PACKAGES)("resolves %s to exactly one version", (name) => {
    expect(resolvedVersions(lockfile, name)).toHaveLength(1);
  });
});

/** Match lockfile resolution tuples, not declaration ranges. A range that nothing installs is not a split. */
function resolvedVersions(lockfile: string, name: string): readonly string[] {
  const pattern = new RegExp(`\\["${escapeRegExp(name)}@([^"]+)"`, "g");
  return [...new Set([...lockfile.matchAll(pattern)].map((match) => match[1]))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
