import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keepPreviousDataForSameHost } from "@/hooks/host/keep-previous-data-same-host";

describe("keepPreviousDataForSameHost", () => {
  it("retains previous data when the previous query's hostId matches", () => {
    const keep = keepPreviousDataForSameHost("host-a");
    const previous = { verdict: "git" };
    expect(
      keep(previous, {
        queryKey: ["host", "host-a", "worktree.listByWorkspacePaths", {}],
      }),
    ).toBe(previous);
  });

  it("drops previous data when the previous query's hostId differs", () => {
    const keep = keepPreviousDataForSameHost("host-b");
    const previous = { verdict: "from-host-a" };
    expect(
      keep(previous, {
        queryKey: ["host", "host-a", "worktree.listByWorkspacePaths", {}],
      }),
    ).toBeUndefined();
  });

  it("retains previous data when the previous query is missing (first paint)", () => {
    const keep = keepPreviousDataForSameHost("host-a");
    const previous = { verdict: "any" };
    expect(keep(previous, undefined)).toBe(previous);
  });

  it("retains previous data for non-host query keys", () => {
    const keep = keepPreviousDataForSameHost("host-a");
    const previous = { rows: [1] };
    expect(keep(previous, { queryKey: ["ui", "something"] })).toBe(previous);
  });

  it("returns undefined when there is no previous data", () => {
    const keep = keepPreviousDataForSameHost("host-a");
    expect(
      keep(undefined, { queryKey: ["host", "host-a", "method", {}] }),
    ).toBeUndefined();
  });
});

/**
 * Wiring pins: each D1 hook must pass its live hostId into this helper. A
 * regression that deletes `placeholderData` or wires bare `keepPreviousData`
 * fails here (source-level) and in the per-hook host-switch integration tests.
 *
 * `use-workspace-entries` has TWO option sites (scoped search + legacy) — both
 * must wire the helper; counting occurrences catches deleting one of them.
 */
describe("D1 wiring pins", () => {
  it("wires keepPreviousDataForSameHost in all four host-keyed hooks", () => {
    // hooks/host/__tests__ → hooks/
    const hooksRoot = join(import.meta.dirname, "../..");
    const files: ReadonlyArray<{
      readonly rel: string;
      readonly minOccurrences: number;
    }> = [
      {
        rel: "worktree/use-worktree-list-by-workspace-paths-query.ts",
        minOccurrences: 1,
      },
      {
        // Two options: { staleTime, placeholderData } for search + legacy.
        rel: "composer/use-workspace-entries.ts",
        minOccurrences: 2,
      },
      {
        rel: "workspace/use-workspace-search-paths-query.ts",
        minOccurrences: 1,
      },
      {
        rel: "workspace/use-workspace-search-text-query.ts",
        minOccurrences: 1,
      },
    ];
    for (const file of files) {
      const source = readFileSync(join(hooksRoot, file.rel), "utf8");
      const matches = source.match(/keepPreviousDataForSameHost/g) ?? [];
      // Import + each call site. For entries: import + one shared const used twice
      // still only 2 mentions (import + const), or import + 2 inlines = 3.
      // Require at least import + one usage; for entries require the identifier
      // appears ≥2 times AND both option objects use `placeholderData`.
      expect(
        matches.length,
        `${file.rel} must reference keepPreviousDataForSameHost`,
      ).toBeGreaterThanOrEqual(file.minOccurrences);
      expect(source).not.toMatch(/placeholderData:\s*keepPreviousData\b/);
      if (file.rel.endsWith("use-workspace-entries.ts")) {
        // Both option sites: `{ staleTime: 30_000, placeholderData }` (shorthand).
        const optionPlaceholderCount = (
          source.match(/placeholderData(?!\s*:)/g) ?? []
        ).length;
        // One const assignment + two option-object shorthand uses = 3, or
        // shorthand twice only if the const is `placeholderData = ...`.
        // Count option objects that include the property (search + legacy).
        const optionObjectsWithPlaceholder = (
          source.match(/staleTime:\s*30_000,\s*placeholderData/g) ?? []
        ).length;
        expect(
          optionObjectsWithPlaceholder,
          "use-workspace-entries must set placeholderData on BOTH search and legacy option objects",
        ).toBe(2);
        expect(optionPlaceholderCount).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
