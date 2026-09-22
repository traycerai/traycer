/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * `worktree.listAllForHost`'s `activityPaths` request field is the whole
 * story of this fix: `null` is the cheap, non-spawning BASE listing every
 * surface may read freely; any non-null value is SELECTION mode, which
 * derives on the host (spawns git per path) and therefore must be a
 * single-path key - the shape every enrichment-reading surface caches under
 * (see `worktree-enrichment-keys.ts` / `invalidate-worktree-changed-caches.ts`).
 * A NEW multi-path site is exactly the amplification bug this fix removed -
 * one `worktree.changed` frame re-deriving every row a batch covers, not just
 * the row it named.
 *
 * This is an AST census, not a runtime test: it walks every non-test
 * production source file for an `activityPaths` property (or shorthand) and
 * requires its value to be the `null` literal UNLESS the exact (file,
 * initializer text) pair is explicitly allowlisted below, each entry with a
 * written reason for why that site is not a cache key spanning multiple rows.
 */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

interface AllowlistEntry {
  readonly file: string;
  readonly initializer: string;
  readonly reason: string;
}

/**
 * Verified via reading the actual source - not a blanket "anything goes"
 * escape hatch. Each entry names the exact file and the exact initializer
 * text a matching site must have, plus why it is legitimately non-null and
 * not itself a multi-path cache key.
 */
const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    file: "components/settings/panels/worktrees-enrichment-batcher.ts",
    initializer: "[path]",
    reason:
      "the per-path key params shared by every enrichment reader - a single-element array, not a batch",
  },
  {
    file: "components/settings/panels/worktrees-enrichment-batcher.ts",
    initializer: "[...paths]",
    reason:
      "the batched WIRE request the coalescing batcher sends - a transport shape, never a cache key (each row still lands under its own per-path key)",
  },
  {
    file: "hooks/worktree/use-worktree-owner-metadata-query.ts",
    initializer: "variables.worktreePaths",
    reason:
      "the forced Refresh mutation's request - its response is split back into per-path cache entries in onSuccess, never cached as one key",
  },
  {
    file: "hooks/epic/use-epic-sweep-worktree-candidates-query.ts",
    initializer: "ownedPaths",
    reason:
      "the Sweep dialog's act-time forced proof, cached under hostQueryKeys.sweepWorktreeCandidates - deliberately OUTSIDE the worktree.listAllForHost method scope, so it is not a multi-path key under that scope at all",
  },
];

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function collectProductionFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      found.push(...collectProductionFiles(full));
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(?:ts|tsx)$/.test(entry)) continue;
    found.push(full);
  }
  return found;
}

function toRelative(file: string): string {
  return path.relative(SRC_DIR, file).split(path.sep).join("/");
}

interface Site {
  readonly relativeFile: string;
  readonly line: number;
  readonly isNullLiteral: boolean;
  readonly initializerText: string;
}

function findActivityPathsSites(file: string): readonly Site[] {
  if (!isFile(file)) return [];
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sites: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "activityPaths"
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(),
      );
      sites.push({
        relativeFile: toRelative(file),
        line: line + 1,
        isNullLiteral: node.initializer.kind === ts.SyntaxKind.NullKeyword,
        initializerText: node.initializer.getText(sourceFile),
      });
    } else if (
      ts.isShorthandPropertyAssignment(node) &&
      node.name.text === "activityPaths"
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(),
      );
      // A shorthand `{ activityPaths }` can never spell the `null` literal -
      // it always carries a variable's value - so it is always a non-null
      // site and must clear the same allowlist bar.
      sites.push({
        relativeFile: toRelative(file),
        line: line + 1,
        isNullLiteral: false,
        initializerText: "activityPaths",
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

interface Census {
  readonly allSites: readonly Site[];
  readonly nullSites: readonly Site[];
  readonly nonNullSites: readonly Site[];
}

let memoised: Census | null = null;

function census(): Census {
  if (memoised === null) {
    const files = collectProductionFiles(SRC_DIR);
    const allSites = files.flatMap((file) => findActivityPathsSites(file));
    memoised = {
      allSites,
      nullSites: allSites.filter((site) => site.isNullLiteral),
      nonNullSites: allSites.filter((site) => !site.isNullLiteral),
    };
  }
  return memoised;
}

describe("worktree.listAllForHost activityPaths census", () => {
  // A vacuous scan (nothing found) would make every assertion below pass by
  // finding nothing to check. Pinning >= 8 known null sites (the base-list
  // reads at the time this test was written: worktrees-listing-query.ts x2,
  // workspace-folder-rows.tsx, worktree-scripts-dialog.tsx,
  // use-epic-sweep-worktree-candidates-query.ts,
  // use-epic-sweep-host-worktree-count-query.ts,
  // use-task-worktree-metadata-query.ts,
  // use-task-delete-worktree-candidates-query.ts) proves the walk actually
  // reaches production code.
  it("finds a non-empty, non-vacuous population of activityPaths sites", () => {
    const { allSites, nullSites } = census();

    expect(allSites.length).toBeGreaterThan(0);
    expect(nullSites.length).toBeGreaterThanOrEqual(8);
  });

  it("every non-null activityPaths site is an explicitly allowlisted single-path or wire-transport shape", () => {
    const { nonNullSites } = census();

    const offences = nonNullSites
      .filter(
        (site) =>
          !ALLOWLIST.some(
            (entry) =>
              entry.file === site.relativeFile &&
              entry.initializer === site.initializerText,
          ),
      )
      .map(
        (site) =>
          `${site.relativeFile}:${String(site.line)} -> activityPaths: ${site.initializerText}`,
      );

    expect(offences).toEqual([]);
  });

  // A stale allowlist entry (the site was renamed, refactored away, or its
  // initializer text changed) would silently stop guarding anything - assert
  // every entry is still hit by a real site.
  it("every allowlist entry is still matched by a live site", () => {
    const { nonNullSites } = census();

    for (const entry of ALLOWLIST) {
      const matched = nonNullSites.some(
        (site) =>
          site.relativeFile === entry.file &&
          site.initializerText === entry.initializer,
      );
      expect(
        matched,
        `allowlist entry ${entry.file} -> ${entry.initializer} has no matching site anymore`,
      ).toBe(true);
    }
  });
});
