/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A few Radix packages coordinate ACROSS component families through
 * module-scoped state rather than through React context, so their guarantees
 * hold only while the whole graph shares one instance of them:
 *
 * - `react-focus-scope` keeps `focusScopesStack`. A dialog's trapped scope
 *   stops yanking focus back only because the popover mounting on top of it
 *   pushes onto that same stack and pauses it.
 * - `react-dismissable-layer` keeps the layer/branch registry and the body
 *   `pointer-events` lock, which is how an open drawer decides that a popover
 *   portalled above it is still interactive.
 * - `react-focus-guards` keeps the global guard count.
 *
 * Two copies means two registries that cannot see each other, and the symptom
 * is never a resolution error: a surface renders and then silently misbehaves
 * (a picker inside a dialog that closes on the same tick it opens; a popover
 * over a drawer that is inert). Both halves of that pair have shipped here.
 *
 * The graph splits without anyone editing a dependency: `radix-ui` pins each
 * internal EXACTLY, so a package outside the monolith that carries its own
 * `@radix-ui/react-dialog` (vaul) - or an `overrides` entry that pins one to a
 * version the monolith did not choose - forks the internals underneath it.
 * That is why the assertion is on the RESOLVED graph and not on any
 * declaration: what matters is how many copies get installed.
 */
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

/**
 * Every resolved version of `name` in the lockfile. Bun writes one entry per
 * resolution as `"<key>": ["<name>@<version>", …]`, where the key is the
 * bare name for the hoisted copy and `<parent>/<name>` for a nested one - so
 * matching the resolution tuple rather than the key counts both alike.
 * Dependency DECLARATIONS use `"<name>": "<range>"` and are deliberately not
 * matched: a declaration that nothing installs is not a split.
 */
function resolvedVersions(lockfile: string, name: string): readonly string[] {
  const pattern = new RegExp(`\\["${escapeRegExp(name)}@([^"]+)"`, "g");
  return [...new Set([...lockfile.matchAll(pattern)].map((match) => match[1]))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
