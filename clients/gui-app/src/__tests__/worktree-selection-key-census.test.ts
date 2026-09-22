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
 * A second census below covers `includeActivity`, so every request that asks
 * for activity facts is a site someone has read. The flag does not decide
 * whether a read derives - the mode does: `includeActivity: true` with
 * `activityPaths: null` does NOT spawn git, because the host serves paged-mode
 * rows from its row cache (traycer-host `WorktreeSetupOrchestrator
 * .listAllForHostRows` -> `readCachedEntry`, and a cache miss answers the row
 * unresolved rather than deriving it inline). It derives only in SELECTION
 * mode (a non-null `activityPaths`) or on `forceRefresh: true`. So a paged
 * `includeActivity: true` costs a larger page, not git, and the
 * `activityPaths` census above is the one that gates derive cost.
 *
 * This is an AST census, not a runtime test: it walks every non-test
 * production source file, in BOTH `clients/gui-app/src` and `clients/shared`
 * (the wire-request builders this fix touched can live in either), for an
 * `activityPaths` or `includeActivity` property (identifier name, string
 * literal name, or shorthand) and requires its value to be the `null` (for
 * `activityPaths`) or `false` (for `includeActivity`) literal UNLESS the
 * exact (file, initializer text) pair is explicitly allowlisted below, each
 * entry with a written reason.
 *
 * Out of this scan's reach, by construction - a source built one of these
 * ways would not be found here, and needs a human read instead:
 * - a COMPUTED property name (`{ [key]: value }`, `{ ["activityPaths"]: v }`)
 * - a spread that could carry either field (`{ ...params }`,
 *   `{ ...perPathEnrichmentParams(path) }`)
 * - `Object.assign` or any other dynamic construction that doesn't write the
 *   property name as source text
 */
const TEST_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUI_APP_SRC_DIR = path.join(TEST_FILE_DIR, "..");
const CLIENTS_SHARED_DIR = path.join(GUI_APP_SRC_DIR, "..", "..", "shared");

interface ScanRoot {
  /** Prepended to every relative file path this root reports. */
  readonly labelPrefix: string;
  readonly dir: string;
}

const ROOTS: readonly ScanRoot[] = [
  { labelPrefix: "", dir: GUI_APP_SRC_DIR },
  { labelPrefix: "clients/shared/", dir: CLIENTS_SHARED_DIR },
];

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
const ACTIVITY_PATHS_ALLOWLIST: readonly AllowlistEntry[] = [
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

interface CountedAllowlistEntry {
  readonly file: string;
  readonly initializer: string;
  /**
   * The EXACT number of live sites this entry covers - not a floor. A count
   * that grows or shrinks means a site was added or removed and the entry
   * needs a human look, not a silent pass.
   */
  readonly expectedCount: number;
  readonly reason: string;
}

/**
 * `includeActivity: true` is legitimate on a selection-mode or forced request
 * (both derive anyway, and the flag adds nothing to that cost), on the one
 * paged, non-forced read below (served from the host's row cache - see the
 * module doc), and on the shorthand telemetry site that is not a request.
 */
const INCLUDE_ACTIVITY_ALLOWLIST: readonly CountedAllowlistEntry[] = [
  {
    file: "components/settings/panels/worktrees-enrichment-batcher.ts",
    initializer: "true",
    expectedCount: 2,
    reason:
      "the per-path key params and the batched wire request - both selection-mode by construction (activityPaths is always non-null there)",
  },
  {
    file: "hooks/worktree/use-worktree-owner-metadata-query.ts",
    initializer: "true",
    expectedCount: 1,
    reason: "the forced Refresh mutation - selection-mode and forced",
  },
  {
    file: "hooks/epic/use-epic-sweep-worktree-candidates-query.ts",
    initializer: "true",
    expectedCount: 1,
    reason:
      "the Sweep dialog's act-time forced proof - selection-mode, own key, outside the listAllForHost method scope",
  },
  {
    file: "hooks/epic/use-task-delete-worktree-candidates-query.ts",
    initializer: "true",
    expectedCount: 1,
    reason:
      "paged (activityPaths: null, forceRefresh: false) - includeActivity: true with activityPaths: null does not spawn git. The host serves paged-mode rows from its row cache (traycer-host WorktreeSetupOrchestrator.listAllForHostRows -> readCachedEntry, and a cache miss answers the row unresolved). It derives only in selection mode or on forceRefresh.",
  },
  {
    file: "components/settings/panels/worktrees-settings-perf.ts",
    initializer: "includeActivity",
    expectedCount: 1,
    reason:
      "the shorthand `{ includeActivity, ... }` in the perf telemetry payload logPerfEvent sends - not a request at all",
  },
];

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

const SKIPPED_DIR_NAMES = new Set(["__tests__", "node_modules", "dist"]);

function collectProductionFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry)) continue;
      found.push(...collectProductionFiles(full));
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(?:ts|tsx)$/.test(entry)) continue;
    found.push(full);
  }
  return found;
}

function toRelative(root: ScanRoot, file: string): string {
  return (
    root.labelPrefix + path.relative(root.dir, file).split(path.sep).join("/")
  );
}

interface Site {
  readonly relativeFile: string;
  readonly line: number;
  readonly isAllowedLiteral: boolean;
  readonly initializerText: string;
}

/** The name a PropertyAssignment or ShorthandPropertyAssignment carries, for an identifier or string-literal key. */
function propertyKeyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function findPropertySites(
  root: ScanRoot,
  file: string,
  propertyName: string,
  allowedLiteralKind: ts.SyntaxKind,
): readonly Site[] {
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
    if (ts.isPropertyAssignment(node)) {
      const name = propertyKeyName(node.name);
      if (name === propertyName) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(),
        );
        sites.push({
          relativeFile: toRelative(root, file),
          line: line + 1,
          isAllowedLiteral: node.initializer.kind === allowedLiteralKind,
          initializerText: node.initializer.getText(sourceFile),
        });
      }
    } else if (
      ts.isShorthandPropertyAssignment(node) &&
      node.name.text === propertyName
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(),
      );
      // A shorthand `{ propertyName }` can never spell the allowed literal -
      // it always carries a variable's value - so it is always a non-allowed
      // site and must clear the same allowlist bar.
      sites.push({
        relativeFile: toRelative(root, file),
        line: line + 1,
        isAllowedLiteral: false,
        initializerText: propertyName,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

function scanAllRoots(
  propertyName: string,
  allowedLiteralKind: ts.SyntaxKind,
): readonly Site[] {
  return ROOTS.flatMap((root) =>
    collectProductionFiles(root.dir).flatMap((file) =>
      findPropertySites(root, file, propertyName, allowedLiteralKind),
    ),
  );
}

interface Census {
  readonly allSites: readonly Site[];
  readonly allowedSites: readonly Site[];
  readonly nonAllowedSites: readonly Site[];
}

function censusOf(
  propertyName: string,
  allowedLiteralKind: ts.SyntaxKind,
): Census {
  const allSites = scanAllRoots(propertyName, allowedLiteralKind);
  return {
    allSites,
    allowedSites: allSites.filter((site) => site.isAllowedLiteral),
    nonAllowedSites: allSites.filter((site) => !site.isAllowedLiteral),
  };
}

let memoisedActivityPaths: Census | null = null;
function activityPathsCensus(): Census {
  if (memoisedActivityPaths === null) {
    memoisedActivityPaths = censusOf(
      "activityPaths",
      ts.SyntaxKind.NullKeyword,
    );
  }
  return memoisedActivityPaths;
}

let memoisedIncludeActivity: Census | null = null;
function includeActivityCensus(): Census {
  if (memoisedIncludeActivity === null) {
    memoisedIncludeActivity = censusOf(
      "includeActivity",
      ts.SyntaxKind.FalseKeyword,
    );
  }
  return memoisedIncludeActivity;
}

/**
 * A FLOOR, not a count: it only proves the walk reaches production code, so a
 * scan that silently finds nothing cannot pass the census vacuously. Adding or
 * removing an ordinary base-list read must not break it, so keep it well below
 * the live number of `activityPaths: null` sites.
 */
const ACTIVITY_PATHS_NULL_SITE_FLOOR = 3;

describe("worktree.listAllForHost activityPaths census", () => {
  it("finds a non-empty, non-vacuous population of activityPaths sites", () => {
    const { allSites, allowedSites } = activityPathsCensus();

    expect(allSites.length).toBeGreaterThan(0);
    expect(allowedSites.length).toBeGreaterThanOrEqual(
      ACTIVITY_PATHS_NULL_SITE_FLOOR,
    );
  });

  it("every non-null activityPaths site is an explicitly allowlisted single-path or wire-transport shape", () => {
    const { nonAllowedSites } = activityPathsCensus();

    const offences = nonAllowedSites
      .filter(
        (site) =>
          !ACTIVITY_PATHS_ALLOWLIST.some(
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
    const { nonAllowedSites } = activityPathsCensus();

    for (const entry of ACTIVITY_PATHS_ALLOWLIST) {
      const matched = nonAllowedSites.some(
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

describe("worktree.listAllForHost includeActivity census", () => {
  it("finds a non-empty population of includeActivity sites", () => {
    const { allSites } = includeActivityCensus();

    expect(allSites.length).toBeGreaterThan(0);
  });

  it("every non-false includeActivity site matches an allowlisted (file, initializer) at its EXACT expected count", () => {
    const { nonAllowedSites } = includeActivityCensus();

    const counts = new Map<string, number>();
    for (const site of nonAllowedSites) {
      const key = `${site.relativeFile}\u0000${site.initializerText}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const offences: string[] = [];
    for (const [key, count] of counts) {
      const [file, initializer] = key.split("\u0000");
      const entry = INCLUDE_ACTIVITY_ALLOWLIST.find(
        (candidate) =>
          candidate.file === file && candidate.initializer === initializer,
      );
      if (entry === undefined) {
        offences.push(
          `${file} -> includeActivity: ${initializer} (${String(count)} site(s)) is not allowlisted`,
        );
      } else if (entry.expectedCount !== count) {
        offences.push(
          `${file} -> includeActivity: ${initializer} - expected exactly ${String(entry.expectedCount)} site(s), found ${String(count)}`,
        );
      }
    }

    expect(offences).toEqual([]);
  });

  // A stale allowlist entry (renamed, refactored away, or its count drifted)
  // would silently stop guarding anything - assert every entry's exact count
  // is still live.
  it("every INCLUDE_ACTIVITY_ALLOWLIST entry still matches its exact expected count", () => {
    const { nonAllowedSites } = includeActivityCensus();

    for (const entry of INCLUDE_ACTIVITY_ALLOWLIST) {
      const actualCount = nonAllowedSites.filter(
        (site) =>
          site.relativeFile === entry.file &&
          site.initializerText === entry.initializer,
      ).length;
      expect(
        actualCount,
        `allowlist entry ${entry.file} -> ${entry.initializer} expected exactly ${String(entry.expectedCount)} site(s), found ${String(actualCount)}`,
      ).toBe(entry.expectedCount);
    }
  });
});
