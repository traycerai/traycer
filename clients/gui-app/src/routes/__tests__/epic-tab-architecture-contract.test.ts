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
  // Cold review #5 / #9: route render adapters must not re-assert layout via
  // synchronizeExternalRef; missing/stale Epic resolution must go through the
  // enveloped activateTabIntent seam (not a raw un-enveloped navigate).
  it("Epic and Draft route adapters do not call synchronizeExternalRef", () => {
    const epicRoute = productionSourceEntries().find(([filePath]) =>
      filePath.endsWith("epic-tab-route-components.tsx"),
    );
    const draftRoute = productionSourceEntries().find(([filePath]) =>
      filePath.endsWith("draft-route-components.tsx"),
    );
    expect(epicRoute, "epic route component source").toBeDefined();
    expect(draftRoute, "draft route component source").toBeDefined();
    if (epicRoute === undefined || draftRoute === undefined) {
      throw new Error("missing route adapter sources");
    }
    expect(epicRoute[1]).not.toMatch(/\bsynchronizeExternalRef\b/);
    expect(draftRoute[1]).not.toMatch(/\bsynchronizeExternalRef\b/);
  });

  it("keeps missing/stale Epic resolution in the permanent controller, not the render adapter", () => {
    const epicRoute = productionSourceEntries().find(([filePath]) =>
      filePath.endsWith("epic-tab-route-components.tsx"),
    );
    const controller = productionSourceEntries().find(([filePath]) =>
      filePath.endsWith("lib/tab-navigation.ts"),
    );
    expect(epicRoute, "epic route component source").toBeDefined();
    expect(controller, "navigation controller source").toBeDefined();
    if (epicRoute === undefined || controller === undefined) {
      throw new Error("missing navigation authority sources");
    }
    const source = epicRoute[1];
    const adapterStart = source.indexOf("function EpicRouteTabSync");
    const adapterEnd = source.indexOf(
      "export function PhaseToEpicMigrationGate",
    );
    expect(adapterStart).toBeGreaterThanOrEqual(0);
    expect(adapterEnd).toBeGreaterThan(adapterStart);
    const adapter = source.slice(adapterStart, adapterEnd);
    expect(adapter).not.toMatch(
      /\b(?:activateTabIntent|openOrFocusEpicIntent|synchronizeExternalRef|navigate)\b/,
    );

    // Missing/stale routes are instead resolved by the continuously mounted
    // controller, which can correlate any canonical replace it issues.
    expect(controller[1]).toMatch(/\bresolveExternalEpic\b/);
    expect(controller[1]).toMatch(/\bissueCorrection\b/);
    expect(controller[1]).toMatch(/tabCommandCoordinator\.activateTab\(/);
  });

  it("keeps /epics/$epicId/$tabId as the only concrete epic route", () => {
    const routeFileNames = Object.keys(routeSources);

    expect(
      routeFileNames.some((filePath) => filePath.endsWith("epics.$epicId.tsx")),
    ).toBe(false);
    // The detail route nests under the `/epics` layout; `TopLevelTabHost`
    // mounts the retained surface above this route adapter.
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
