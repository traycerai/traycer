import { describe, expect, it } from "vitest";
import routeTreeSource from "@/routeTree.gen?raw";

const routeSources = import.meta.glob<string>("../*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});
const guiSources = import.meta.glob<string>("../../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});
const desktopSources = import.meta.glob<string>(
  "../../../../desktop/src/**/*.{ts,tsx}",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);

function productionSourceEntries(): readonly (readonly [string, string])[] {
  return Object.entries({ ...guiSources, ...desktopSources }).filter(
    ([filePath]) =>
      !filePath.includes("/__tests__/") && !/\.test\.(ts|tsx)$/.test(filePath),
  );
}

function matchingFiles(pattern: RegExp): readonly string[] {
  return productionSourceEntries()
    .filter(([, source]) => pattern.test(source))
    .map(([filePath]) => filePath);
}

describe("epic tab architecture contracts", () => {
  it("keeps /epics/$epicId/$tabId as the only concrete epic route", () => {
    const routeFileNames = Object.keys(routeSources);

    expect(
      routeFileNames.some((filePath) => filePath.endsWith("epics.$epicId.tsx")),
    ).toBe(false);
    // The detail route nests under the `/epics` layout (which mounts the
    // keep-alive `EpicTabHost`), so the file dropped its layout-opt-out `_`.
    expect(
      routeFileNames.some((filePath) =>
        filePath.endsWith("epics.$epicId.$tabId.tsx"),
      ),
    ).toBe(true);
    expect(
      routeFileNames.some((filePath) =>
        filePath.endsWith("epics_.$epicId.$tabId.tsx"),
      ),
    ).toBe(false);

    expect(routeTreeSource).toMatch(/['"]\/epics\/\$epicId\/\$tabId['"]/);
    // Old layout-opt-out id is gone now that the detail route is nested.
    expect(routeTreeSource).not.toMatch(/['"]\/epics_\/\$epicId\/\$tabId['"]/);
    expect(routeTreeSource).not.toMatch(/path:\s*['"]\/epics\/\$epicId['"]/);
    expect(routeTreeSource).not.toContain("EpicsEpicIdRoute");
  });

  it("does not reference removed one-tab-per-epic store fields or actions", () => {
    const legacySymbols = [
      "openEpicTabs",
      "canvasByEpicId",
      "moveOpenEpicTab",
      "activateEpicTab",
      "discardEpicTabState",
      "openArtifactInEpic",
      "closeTabInEpic",
      "renameEpicTab",
      "findOpenArtifactInEpic",
      "getCanvasRootForEpic",
      "closeOtherTabsInEpic",
      "setActiveTabInEpic",
      "setActiveGroupInEpic",
      "splitGroupEmptyInEpic",
    ];

    const failures = legacySymbols.flatMap((symbol) =>
      matchingFiles(new RegExp(`\\b${symbol}\\b`)).map(
        (filePath) => `${symbol}: ${filePath}`,
      ),
    );

    expect(failures).toEqual([]);
  });

  it("does not emit epic routes that omit tabId", () => {
    const forbiddenPatterns = [
      /["'`]\/epics\/\$epicId["'`]/,
      /\/epics\/\$\{epicId\}(?!\/)/,
    ];

    const failures = forbiddenPatterns.flatMap((pattern) =>
      matchingFiles(pattern),
    );

    expect(failures).toEqual([]);
  });
});
