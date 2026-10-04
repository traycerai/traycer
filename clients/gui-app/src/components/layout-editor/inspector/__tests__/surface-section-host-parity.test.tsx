import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutAreaLevel } from "@/components/layout-editor/inspector/layout-form";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import { LayoutSettingsPanel } from "@/components/settings/panels/layout-settings-panel";
import type { SurfaceGroupId } from "@/components/layout-editor/regions/region-grammar";
import { USAGE_PROVIDER_IDS } from "@/lib/layout/layout-arrangement";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * `SurfaceSection` is the ONE tree the page and the editor dock both draw
 * (L-03): the two hosts differ only in density and in where a deeper level
 * opens (`layout-form-host.ts`), never in which rows exist, what they are
 * called, or what operating one writes. Run through the REAL hosts rather
 * than a bare `<SurfaceSection>` fixture, so the claim covers each host's own
 * navigation wiring too - `LayoutSettingsPanel`'s tabs and `LayoutAreaLevel`'s
 * back row - not just the shared component underneath it.
 */

// Same one boundary `layout-settings-panel.test.tsx` and
// `provider-limits-choose.test.tsx` mock: every area stays mounted
// (`forceMount`), so the page's Status bar tab is on screen, disclosure and
// all, whichever tab is active.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));

vi.mock(
  "@/components/layout-editor/inspector/provider-limit-windows",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/layout-editor/inspector/provider-limit-windows")
    >()),
    ProviderLimitWindowsReader: (props: {
      readonly children: (limits: {
        windows: ReadonlyArray<never>;
        drawnKeys: ReadonlyArray<never>;
      }) => ReactNode;
    }) => props.children({ windows: [], drawnKeys: [] }),
    LayoutUsageProvider: (props: { readonly children: ReactNode }) =>
      props.children,
  }),
);

vi.mock(
  "@/components/layout-editor/inspector/use-layout-usage",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/components/layout-editor/inspector/use-layout-usage")
      >();
    return {
      ...original,
      useLayoutUsage: () => ({
        ...original.EMPTY_USAGE,
        providerIds: USAGE_PROVIDER_IDS,
        cluster: { kind: "no-providers" as const },
        hostName: "the watched host",
      }),
    };
  },
);

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

/** The editor dock's own composition of `LayoutAreaLevel` (`layout-editor.tsx`'s). */
function InspectorArea(props: { readonly area: SurfaceGroupId }): ReactNode {
  return (
    <LayoutFormHostContext value="inspector">
      <LayoutAreaLevel area={props.area} />
    </LayoutFormHostContext>
  );
}

function renderInspector(area: SurfaceGroupId): HTMLElement {
  act(() => {
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
    useLayoutEditorStore.getState().openArea(area, null);
  });
  return render(<InspectorArea area={area} />).container;
}

async function renderPageArea(areaLabel: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(<LayoutSettingsPanel />);
  await user.click(
    screen.getByRole("tab", { name: new RegExp(`^${areaLabel}`) }),
  );
  return screen.getByRole("tabpanel", { name: new RegExp(`^${areaLabel}`) });
}

function rowIds(scope: ParentNode): ReadonlyArray<string> {
  return [...scope.querySelectorAll("[data-sortable-id]")].map(
    (node) => node.getAttribute("data-sortable-id") ?? "",
  );
}

/** Every named control's accessible name, in document order. */
function controlNames(scope: ParentNode): ReadonlyArray<string> {
  return [
    ...scope.querySelectorAll<HTMLElement>(
      '[role="radiogroup"], [role="switch"], [role="checkbox"]',
    ),
  ].map((node) => node.getAttribute("aria-label") ?? "");
}

function row(scope: ParentNode, id: string): HTMLElement {
  const node = scope.querySelector(`[data-sortable-id="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`no such row: ${id}`);
  return node;
}

/**
 * One region's override leaf, read by a dynamic key: `LayoutOverrides` has no
 * index signature (each region's bag is its own interface), the same reason
 * `layout-diff.ts`'s own generic readers use `Reflect.get` rather than a cast.
 */
function overrideLeaf(regionId: string, key: string): unknown {
  const region: unknown = Reflect.get(
    useLayoutStore.getState().overrides,
    regionId,
  );
  if (typeof region !== "object" || region === null) return undefined;
  const leaf: unknown = Reflect.get(region, key);
  return leaf;
}

function resetStore(): void {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
}

beforeEach(resetStore);

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

interface AreaCase {
  readonly area: SurfaceGroupId;
  readonly areaLabel: string;
  readonly disclosingRegion: string;
  readonly optionLabel: string;
  readonly key: "style";
  readonly value: string;
}

const CASES: ReadonlyArray<AreaCase> = [
  {
    area: "chat",
    areaLabel: "Chat",
    disclosingRegion: "contextUsage",
    optionLabel: "Ring only",
    key: "style",
    value: "ring-only",
  },
  {
    area: "composer",
    areaLabel: "Composer",
    disclosingRegion: "model",
    optionLabel: "Bars",
    key: "style",
    value: "bars",
  },
];

describe("the same SurfaceSection tree in both hosts (L-03)", () => {
  it.each(CASES)(
    "draws the same $area rows, with the same controls, once $disclosingRegion is expanded",
    async (testCase) => {
      const pageSurface = await renderPageArea(testCase.areaLabel);
      fireEvent.click(
        within(row(pageSurface, testCase.disclosingRegion)).getByRole("button"),
      );
      const pageIds = rowIds(pageSurface);
      const pageControls = controlNames(pageSurface);
      cleanup();
      resetStore();

      const inspectorRoot = renderInspector(testCase.area);
      fireEvent.click(
        within(row(inspectorRoot, testCase.disclosingRegion)).getByRole(
          "button",
        ),
      );
      const inspectorIds = rowIds(inspectorRoot);
      const inspectorControls = controlNames(inspectorRoot);

      expect(pageIds).toEqual(inspectorIds);
      expect(pageIds.length).toBeGreaterThan(0);
      expect(pageControls).toEqual(inspectorControls);
      expect(pageControls).toContain("Style");
    },
  );

  it.each(CASES)(
    "writes the same store value from $area's Style radio in both hosts",
    async (testCase) => {
      const pageSurface = await renderPageArea(testCase.areaLabel);
      fireEvent.click(
        within(row(pageSurface, testCase.disclosingRegion)).getByRole("button"),
      );
      fireEvent.click(
        within(screen.getByRole("radiogroup", { name: "Style" })).getByRole(
          "radio",
          { name: testCase.optionLabel },
        ),
      );
      expect(overrideLeaf(testCase.disclosingRegion, testCase.key)).toBe(
        testCase.value,
      );
      cleanup();
      resetStore();

      const inspectorRoot = renderInspector(testCase.area);
      fireEvent.click(
        within(row(inspectorRoot, testCase.disclosingRegion)).getByRole(
          "button",
        ),
      );
      fireEvent.click(
        within(screen.getByRole("radiogroup", { name: "Style" })).getByRole(
          "radio",
          { name: testCase.optionLabel },
        ),
      );
      expect(overrideLeaf(testCase.disclosingRegion, testCase.key)).toBe(
        testCase.value,
      );
    },
  );
});
