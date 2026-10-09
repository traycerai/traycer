import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutSettingsPanel } from "@/components/settings/panels/layout-settings-panel";
import { setMobileApp, setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  LAYOUT_REGION_LIST,
  regionFacts,
} from "@/components/layout-editor/regions/region-facts";
import { SURFACE_GROUPS } from "@/components/layout-editor/regions/region-grammar";
import { RAIL_REGION_IDS } from "@/lib/layout/rail";
import { providerDisplayName } from "@/lib/provider-ordering";
import {
  DEFAULT_ARRANGEMENT,
  USAGE_PROVIDER_IDS,
} from "@/lib/layout/layout-arrangement";
import type { HideableRegionId } from "@/lib/layout/layout-values";
import {
  navigateToLayoutArea,
  navigateToLayoutRegion,
  navigateToLayoutRegionRow,
} from "@/lib/settings-navigation";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  effectiveLayoutValues,
  PRESET_VALUES,
} from "@/lib/layout/layout-presets";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { searchSettings } from "@/lib/settings-search/settings-search";
import { useSettingsAnchorReveal } from "@/components/settings/use-settings-anchor-reveal";

// The provider list is read through the watched host's scope; this page needs
// it mounted, never connected.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));

// A provider row's disclosure draws `ProviderLimitsControl`, which reads the
// windows the strip has already read (L-96, L-106) - through the watched host
// scope, a profile selection and the segment model, none of which this page is
// about. Mocked at the same one boundary `provider-limits-choose.test.tsx`
// mocks, so the page is tested for its COMPOSITION and the control is tested
// where it lives.
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
    // The page wraps itself in this directly (the shared watched-usage read),
    // which resolves a host scope through a runner-host provider this suite
    // has none of. A pass-through here, and the fixed catalog below, keep the
    // "usage providers are a Status bar list" cases drawing real rows without
    // standing up that scope for real.
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

const navigateMock = vi.hoisted(() => vi.fn());
const openLayoutEditorMock = vi.hoisted(() => vi.fn());

// The width gate reads the window, and the door is not what this suite is
// about: every case below wants the page's own rows, not a session.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigateMock,
}));

vi.mock("@/lib/layout/editor-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/layout/editor-session")>()),
  openLayoutEditor: openLayoutEditorMock,
}));

function resetLayout(): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
}

beforeEach(() => {
  setMobileApp(false);
  resetLayout();
});
afterEach(() => {
  cleanup();
  setMobileApp(false);
  setPhoneLayoutOnly(false);
  resetLayout();
  setSystemTabModalApi(null);
  useSettingsSearchStore.setState({
    query: "",
    pendingReveal: null,
    handoffPending: false,
  });
  navigateMock.mockClear();
  openLayoutEditorMock.mockClear();
  useLayoutEditorStore.getState().endSession();
});

/** One region's effective value, which is what a row draws and writes. */
function shownValue(regionId: HideableRegionId): string {
  const snapshot = useLayoutStore.getState();
  return effectiveLayoutValues(snapshot.basePreset, snapshot.overrides)[
    regionId
  ].shown;
}

/** Every row of every list on the page, by the id it carries. */
function rowIds(): ReadonlyArray<string> {
  return [
    ...document.querySelectorAll("[data-sortable-id], [data-region-section]"),
  ].map(
    (node) =>
      node.getAttribute("data-sortable-id") ??
      node.getAttribute("data-region-section") ??
      "",
  );
}

function row(id: string): HTMLElement {
  const nodes = document.querySelectorAll(
    `[data-sortable-id="${id}"], [data-region-section="${id}"]`,
  );
  const node = nodes[0];
  if (!(node instanceof HTMLElement)) throw new Error(`no such row: ${id}`);
  return node;
}

function surface(id: string): HTMLElement {
  return screen.getByTestId(`layout-surface-${id}`);
}

/**
 * Whether a `forceMount`ed tab's own `TabsContent` carries `hidden` - every
 * tab stays mounted now (L-166's Presence-timing fix), so absence from the
 * DOM no longer means inactive; the `hidden` attribute Radix toggles on the
 * inactive `role="tabpanel"` does.
 */
function tabPanelHiddenFor(testId: string): boolean {
  const panel = screen.getByTestId(testId).closest('[role="tabpanel"]');
  if (!(panel instanceof HTMLElement)) {
    throw new Error(`no tabpanel ancestor for ${testId}`);
  }
  return panel.hasAttribute("hidden");
}

/** The one `role="tabpanel"` Radix has NOT marked `hidden` right now. */
function activeTabPanel(): HTMLElement {
  const panel = document.querySelector('[role="tabpanel"]:not([hidden])');
  if (!(panel instanceof HTMLElement)) throw new Error("no active tabpanel");
  return panel;
}

function renderPanel(): void {
  render(<LayoutSettingsPanel />);
}

/**
 * Switches the page to one surface's own tab, the way a click on its
 * `TabsTrigger` would. Every tab stays mounted (`forceMount`), so this is
 * about which one is VISIBLE, not which one exists - `surface()` finds a
 * hidden tab's rows too, so a test that means "the active tab's rows" reads
 * this first.
 */
async function goToSurfaceTab(user: UserEvent, id: string): Promise<void> {
  const label = SURFACE_GROUPS.find((group) => group.id === id)?.label ?? id;
  // Anchored prefix, not exact: a changed area's tab carries a sr-only ",
  // changed" suffix in its accessible name (H2).
  await user.click(screen.getByRole("tab", { name: new RegExp(`^${label}`) }));
}

/**
 * The full-width host of the one layout form (L-03), after G6.
 *
 * What is pinned here is the SHAPE the owner asked for: one tab per surface,
 * the region as a row inside it, and each shared group control drawn exactly
 * once. The rows' own behaviour is covered where the components live
 * (`components/layout-editor/inspector`); what this page owns is which of
 * them appear, on which tab, and how many times.
 */
describe("Settings - Layout", () => {
  it("shows every region as a row inside its own surface's tab", async () => {
    const user = userEvent.setup();
    renderPanel();

    for (const group of SURFACE_GROUPS) {
      await goToSurfaceTab(user, group.id);
      expect(surface(group.id)).toBeTruthy();
      for (const region of LAYOUT_REGION_LIST.filter(
        (entry) => entry.surface === group.id,
      )) {
        expect(surface(group.id).textContent).toContain(region.name);
      }
    }
  });

  it("puts the Presets tab first, then every surface in reading order", () => {
    renderPanel();

    const labels = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(labels[0]).toBe(LAYOUT.definitions.presets.label);
    expect(labels.slice(1)).toEqual(SURFACE_GROUPS.map((group) => group.label));
  });

  describe("de-duplication (L-92, L-95)", () => {
    it("gives the Sidebar ONE list holding all nine panels plus its dividers", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "sidebar");

      const sidebar = surface("sidebar");
      const panelRows = [...sidebar.querySelectorAll("[data-sortable-id]")].map(
        (node) => node.getAttribute("data-sortable-id") ?? "",
      );

      for (const railId of RAIL_REGION_IDS) {
        expect(
          panelRows.filter((id) => id === railId),
          railId,
        ).toHaveLength(1);
      }
      // Dividers are items of the same list (L-25), so the row count is the
      // whole rail - one list, not nine copies of it.
      expect(panelRows).toHaveLength(DEFAULT_ARRANGEMENT.rail.length);
      expect(
        within(sidebar).getAllByRole("button", { name: "Add divider" }),
      ).toHaveLength(1);
    });

    /**
     * The Composer card's dock list. The claim is the one the ticket is
     * about: every member in `DEFAULT_ARRANGEMENT.dock`, reorderable, in the
     * stored order, with no row of a different kind mixed in - the page reads
     * the arrangement, so a member that had to be spelled out per region
     * somewhere would show up here as a missing or a stray row.
     */
    it("gives the Composer's dock list every stored member, in the stored order", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "composer");

      const composerRows = [
        ...surface("composer").querySelectorAll("[data-sortable-id]"),
      ].map((node) => node.getAttribute("data-sortable-id") ?? "");
      const dockRows = composerRows.filter((id) =>
        DEFAULT_ARRANGEMENT.dock.some((member) => member === id),
      );

      expect(dockRows).toEqual([...DEFAULT_ARRANGEMENT.dock]);
      expect(dockRows).toHaveLength(DEFAULT_ARRANGEMENT.dock.length);
      for (const id of DEFAULT_ARRANGEMENT.dock) {
        expect(
          screen.queryAllByRole("radiogroup", {
            name: `${regionFacts(id).name} display`,
          }),
          id,
        ).toHaveLength(1);
      }
    });

    it("draws no region's row twice within its own surface's tab", async () => {
      const user = userEvent.setup();
      renderPanel();

      for (const group of SURFACE_GROUPS) {
        await goToSurfaceTab(user, group.id);
        const ids = rowIds();
        for (const region of LAYOUT_REGION_LIST.filter(
          (entry) => entry.surface === group.id,
        )) {
          expect(
            ids.filter((id) => id === region.id),
            region.name,
          ).toHaveLength(1);
        }
      }
    });

    it("gives every region with a state control exactly one, in one vocabulary", async () => {
      const user = userEvent.setup();
      renderPanel();

      for (const group of SURFACE_GROUPS) {
        await goToSurfaceTab(user, group.id);
        for (const region of LAYOUT_REGION_LIST.filter(
          (entry) => entry.surface === group.id,
          // Model has no Hide at all (G6): the picker always draws, so it has
          // no state control to be duplicated. Covered on its own below.
        ).filter((entry) => entry.id !== "model")) {
          // The two readings are sections with a Show switch in the header;
          // every other region keeps its one display control.
          const section =
            region.id === "usageLimits" || region.id === "resourceMonitor";
          // One wording for all three option sets (L-121): the page used to
          // carry two visibility vocabularies, a `Switch` and a tri-state, and
          // a dock row carried a size control AND a switch for one value.
          expect(
            screen.queryAllByRole("radiogroup", {
              name: `${region.name} display`,
            }),
            region.name,
          ).toHaveLength(section ? 0 : 1);
          expect(
            screen.queryAllByRole("switch", { name: `Show ${region.name}` }),
            region.name,
          ).toHaveLength(section ? 1 : 0);
        }
      }
    });

    it("draws no display control for Model, whose picker always shows (G6)", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "composer");

      expect(
        screen.queryByRole("radiogroup", { name: "Model display" }),
      ).toBeNull();
    });

    it("says each list's instruction once, with its rule joined to it", async () => {
      const user = userEvent.setup();
      renderPanel();

      let long = 0;
      let short = 0;
      let queued = 0;
      let pinnedCount = 0;
      let pinnedInComposer = false;

      for (const group of SURFACE_GROUPS) {
        await goToSurfaceTab(user, group.id);
        // Scoped to the ACTIVE tabpanel: every tab stays mounted now
        // (`forceMount`), so an unscoped query would also match the same
        // text sitting inert in a tab visited on an earlier pass.
        const panel = within(activeTabPanel());
        long += panel.queryAllByText(
          "Drag to reorder, here or on the canvas. Drop one icon onto the middle of another to stack them in one panel. Add a divider to space icons apart.",
        ).length;
        short += panel.queryAllByText(
          "Drag to reorder, here or on the canvas.",
        ).length;
        // The fixed Message queue is said by the list it sits under.
        queued += panel.queryAllByText(
          "Drag to reorder, here or on the canvas. The message queue stays next to the message box.",
        ).length;
        // The pinned-right note belongs to the Toolbar-right LIST, so it is
        // part of that list header's one line rather than a footnote under
        // the card (redesign 4.8).
        const pinnedHere = panel.queryAllByText(
          "Drag to reorder, here or on the canvas. The model chip stays on the right.",
        );
        pinnedCount += pinnedHere.length;
        if (pinnedHere.length > 0) {
          pinnedInComposer = surface(group.id).contains(pinnedHere[0]);
        }
      }

      expect(long).toBe(1);
      expect(short).toBe(1);
      expect(queued).toBe(1);
      expect(pinnedCount).toBe(1);
      expect(pinnedInComposer).toBe(true);
    });

    it("gives each strip reading its own bar and side, and shares neither (L-156)", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "statusBar");

      // The row that moved both at once is gone: where a reading lives is the
      // region's own pick now, behind its own disclosure.
      expect(within(surface("statusBar")).queryByText("Show these in")).toBe(
        null,
      );

      const names = {
        usageLimits: "Usage limits",
        resourceMonitor: "Resource monitor",
      } as const;
      for (const regionId of ["usageLimits", "resourceMonitor"] as const) {
        const name = names[regionId];
        // One picker for the bar and the end of it, and no second row for either.
        expect(
          within(row(regionId)).getAllByRole("radiogroup", {
            name: `${name} location`,
          }),
        ).toHaveLength(1);
        expect(
          within(row(regionId)).queryByRole("radiogroup", {
            name: `${name} side`,
          }),
        ).toBeNull();
      }
    });

    it("keeps only what the phone footer honours: no Location, Density in the footer's words, and nothing live while the footer is off (L-162, U1)", async () => {
      // The installed app, which draws the phone layout at every width.
      setMobileApp(true);
      setPhoneLayoutOnly(true);
      // Both in the Tab strip, where a desktop window would offer Density in
      // its own words; the footer ignores the pick.
      useLayoutStore.setState({
        ...DEFAULT_LAYOUT_SNAPSHOT,
        arrangement: {
          ...DEFAULT_LAYOUT_SNAPSHOT.arrangement,
          usageHost: "header",
          resourceHost: "header",
        },
      });
      // Agent rows stay on at the shipped default, and Metrics still follows
      // the gate: the phone layout draws no agent rows to keep it live
      // (`METRICS`, L-174).
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "statusBar");

      const names = {
        usageLimits: "Usage limits",
        resourceMonitor: "Resource monitor",
      } as const;
      for (const regionId of ["usageLimits", "resourceMonitor"] as const) {
        const name = names[regionId];
        const opened = within(row(regionId));
        // Where a reading sits is a desktop-layout choice: not offered here.
        expect(
          opened.queryByRole("radiogroup", { name: `${name} location` }),
        ).toBeNull();
        // Density is drawn: the footer honours it, and Auto is detailed there.
        expect(
          opened.getByRole("radiogroup", { name: "Density" }),
        ).not.toBeNull();
        expect(
          opened.getByText("Auto is detailed in the status bar."),
        ).not.toBeNull();
      }

      // The switch is the area's first row, and says what off means.
      const footerSwitch = screen.getByRole("switch", {
        name: "Status bar on small screens",
      });
      expect(footerSwitch.getAttribute("aria-checked")).toBe("false");
      expect(
        screen.getByText(
          "Off, usage and resources show as icons in the header.",
        ),
      ).not.toBeNull();
      expect(
        footerSwitch.compareDocumentPosition(row("usageLimits")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      // While it is off, every reading detail row stays drawn but disabled by
      // the ONE hint under the switch, which each one's group points at; the
      // two Show switches stay live, since they decide the header's icons.
      const hint = screen.getByText(
        "Turn on Status bar on small screens to use these. Show still decides the header icons.",
      );
      const remaining = within(row("usageLimits")).getByRole("radio", {
        name: "Remaining",
      });
      const cpu = within(row("resourceMonitor")).getByRole("checkbox", {
        name: "CPU",
      });
      for (const readout of [remaining, cpu]) {
        expect(readout.matches(":disabled")).toBe(true);
        // Every group around it, the row's own and the section's gate.
        const described: string[] = [];
        for (
          let group = readout.closest("fieldset");
          group !== null;
          group = group.parentElement?.closest("fieldset") ?? null
        ) {
          described.push(group.getAttribute("aria-describedby") ?? "");
        }
        expect(described.join(" ").split(" ")).toContain(hint.id);
      }
      for (const name of ["Show Usage limits", "Show Resource monitor"]) {
        expect(screen.getByRole("switch", { name }).matches(":disabled")).toBe(
          false,
        );
      }

      await user.click(footerSwitch);

      // On: no hint, and the same readouts operable.
      expect(
        screen.queryByText(
          "Turn on Status bar on small screens to use these. Show still decides the header icons.",
        ),
      ).toBeNull();
      expect(remaining.matches(":disabled")).toBe(false);
      expect(cpu.matches(":disabled")).toBe(false);
    });
  });

  describe("the phone footer's gate in a narrow browser tab (U1)", () => {
    // The row keys on the PHONE LAYOUT, which a browser tab below 768px draws
    // too, never on the installed app alone.
    it("draws the switch first in its area, gates the readings behind one linked hint, and keeps Density", async () => {
      setMobileApp(false);
      setPhoneLayoutOnly(true);
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "statusBar");

      const footerSwitch = screen.getByRole("switch", {
        name: "Status bar on small screens",
      });
      const firstRow = surface("statusBar").querySelector(
        "[data-sortable-id], [data-layout-form-row]",
      );
      expect(firstRow?.contains(footerSwitch)).toBe(true);

      const hint = screen.getByText(
        "Turn on Status bar on small screens to use these. Show still decides the header icons.",
      );
      const remaining = within(row("usageLimits")).getByRole("radio", {
        name: "Remaining",
      });
      expect(remaining.matches(":disabled")).toBe(true);
      const described: string[] = [];
      for (
        let group = remaining.closest("fieldset");
        group !== null;
        group = group.parentElement?.closest("fieldset") ?? null
      ) {
        described.push(group.getAttribute("aria-describedby") ?? "");
      }
      expect(described.join(" ").split(" ")).toContain(hint.id);
      // Density is a row the footer honours, so it is drawn (and gated the
      // same way) rather than removed.
      expect(
        within(row("usageLimits")).getByRole("radiogroup", { name: "Density" }),
      ).not.toBeNull();

      await user.click(footerSwitch);

      expect(remaining.matches(":disabled")).toBe(false);
      expect(
        screen.queryByText(
          "Turn on Status bar on small screens to use these. Show still decides the header icons.",
        ),
      ).toBeNull();
    });

    it("is absent where no phone layout is drawn", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "statusBar");

      expect(
        screen.queryByRole("switch", { name: "Status bar on small screens" }),
      ).toBeNull();
    });
  });

  describe("the rail's tri-state (L-93, D5)", () => {
    it("writes auto, shown and hidden from the row's one control", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "sidebar");
      // `railComments` still carries a presence hint ("Auto - appears when an
      // artifact is open"), which is what earns it the three-way control
      // (G6): most rail panels have no rule of their own any more and only
      // offer Shown/Hidden, whose "on" writes `auto` (see the other test in
      // this block, which exercises exactly that two-option row).
      const comments = within(row("railComments"));

      await user.click(comments.getByRole("radio", { name: "Shown" }));
      expect(shownValue("railComments")).toBe("shown");

      await user.click(comments.getByRole("radio", { name: "Hidden" }));
      expect(shownValue("railComments")).toBe("hidden");

      // Back to `auto` reads as no override at all, because `auto` IS the
      // shipped value - so the effective value is what this asserts on.
      await user.click(comments.getByRole("radio", { name: "Auto" }));
      expect(shownValue("railComments")).toBe("auto");
    });

    it("keeps a pinned Shown pinned through any other interaction on the page", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "sidebar");

      await user.click(
        within(row("railPullRequests")).getByRole("radio", { name: "Shown" }),
      );
      expect(shownValue("railPullRequests")).toBe("shown");

      // The eye button on every rail list row is what used to undo this: it
      // wrote through `regionShownOnValue`, so two presses anywhere on the
      // page turned the pin back into `auto` without saying so (D5). There is
      // one control per region now, and nothing else on the page can reach
      // this value.
      expect(
        screen.queryAllByRole("button", { name: /^(Hide|Show) Pull/ }),
      ).toEqual([]);

      await user.click(
        within(row("railAgents")).getByRole("radio", { name: "Hidden" }),
      );
      await user.click(row("railPullRequests"));

      expect(shownValue("railPullRequests")).toBe("shown");
    });
  });

  it("writes the region's own value from its row's state control", async () => {
    const user = userEvent.setup();
    renderPanel();
    await goToSurfaceTab(user, "chat");

    await user.click(
      within(row("minimap")).getByRole("radio", { name: "Hidden" }),
    );

    expect(useLayoutStore.getState().overrides.minimap?.shown).toBe("hidden");
  });

  describe("the pictures (L-120, redesign 3.2)", () => {
    it("opens the Sidebar card with its first row, not with a plinth", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "sidebar");

      const sidebar = surface("sidebar");
      // The word the deleted plinth printed. Its absence is the complaint
      // L-118 was filed about, and it is not a class-name assertion.
      expect(within(sidebar).queryByText("Specimen")).toBeNull();
      // Below the surface's own Side row, the first button in the card is the
      // first panel's own grab, so the list that changes the rail comes next.
      const focusable = sidebar.querySelector("[data-row-grab]");
      const firstRow = sidebar.querySelector("[data-sortable-id]");
      expect(firstRow?.contains(focusable ?? null)).toBe(true);
    });

    it("draws each Sidebar row's registry icon in the icon column, like every other list", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "sidebar");

      // The rail's own 1:1 button used to stand in the icon column, which
      // pushed these names off the column every other row's name starts in.
      for (const railId of RAIL_REGION_IDS) {
        expect(
          row(railId).querySelectorAll("[data-row-icon]"),
          railId,
        ).toHaveLength(1);
        expect(
          row(railId).querySelectorAll("[data-row-glyph]"),
          railId,
        ).toHaveLength(0);
      }
    });
  });

  describe("the Profiles list is part of Usage limits", () => {
    it("draws a row per provider with its own eye, and no Limits pick (it lives in Providers)", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "statusBar");

      const statusBar = within(surface("statusBar"));
      for (const providerId of DEFAULT_ARRANGEMENT.usageProviders) {
        expect(row(providerId), providerId).toBeTruthy();
      }
      expect(statusBar.getByText("Profiles")).toBeTruthy();
      expect(
        statusBar.queryByRole("radiogroup", { name: "Limits" }),
      ).toBeNull();
      const first = DEFAULT_ARRANGEMENT.usageProviders[0];
      expect(
        within(row(first)).getByRole("button", {
          name: `Hide ${providerDisplayName(first)}`,
        }),
      ).toBeTruthy();
    });
  });

  describe("applying a preset clears the per-region delta (L-133 overturned)", () => {
    it("replaces the pick with the preset's own value and drops the delta", () => {
      act(() => {
        useLayoutStore.getState().setRegionValues("mic", { shown: "shown" });
        useLayoutStore.getState().applyPreset("compact");
      });
      renderPanel();

      // The apply cleared the delta, so the status line reads the preset
      // name alone. The Presets tab is the page's default, so it needs no
      // switch.
      expect(screen.getByTestId("preset-status-line").textContent).toBe(
        "Compact",
      );
      expect(useLayoutStore.getState().overrides).toEqual({});
      expect(shownValue("mic")).toBe(PRESET_VALUES.compact.mic.shown);
    });
  });

  describe("the safety net (L-20, P-6)", () => {
    it("restores every value and every arrangement field", async () => {
      const user = userEvent.setup();
      act(() => {
        useLayoutStore.getState().applyPreset("compact");
        useLayoutStore.getState().setRegionValues("minimap", {
          shown: "hidden",
        });
        useLayoutStore.getState().setArrangement({
          ...DEFAULT_ARRANGEMENT,
          usageHost: "header",
          minimapSide: "left",
          mobileFooter: true,
          hiddenProviders: [DEFAULT_ARRANGEMENT.usageProviders[0]],
          providerLimits: {
            [DEFAULT_ARRANGEMENT.usageProviders[0]]: { limitKeys: ["5h"] },
          },
          dock: [...DEFAULT_ARRANGEMENT.dock].reverse(),
        });
      });
      // The reset button lives on the Presets tab, the page's default, so no
      // tab switch is needed to reach it.
      renderPanel();

      await user.click(screen.getByRole("button", { name: "Reset layout…" }));
      await user.click(screen.getByTestId("confirm-action"));

      const state = useLayoutStore.getState();
      expect(state.basePreset).toBe("default");
      expect(state.overrides).toEqual({});
      expect(state.arrangement.usageHost).toBe(DEFAULT_ARRANGEMENT.usageHost);
      expect(state.arrangement.minimapSide).toBe(
        DEFAULT_ARRANGEMENT.minimapSide,
      );
      expect(state.arrangement.mobileFooter).toBe(false);
      expect(state.arrangement.hiddenProviders).toEqual([]);
      expect(state.arrangement.providerLimits).toEqual({});
      expect(state.arrangement.dock).toEqual(DEFAULT_ARRANGEMENT.dock);
    });

    it("sits after the presets block on its own tab, toned danger, and inoperable on an untouched layout", () => {
      renderPanel();

      // Reset Everything merged into the Presets tab (G6): the floor is no
      // longer the last card on a single scrolling page, it is the last thing
      // in the tab that opens by default.
      const presets = screen.getByTestId("layout-presets-group");
      const card = screen.getByTestId("layout-reset-group");
      expect(
        presets.compareDocumentPosition(card) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // Showing the floor and saying you are standing on it, rather than a
      // card that vanishes (5.8).
      expect(
        within(card)
          .getByRole("button", { name: "Reset layout…" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("marks a moved region's row and gives it a revert", async () => {
      const user = userEvent.setup();
      act(() => {
        useLayoutStore.getState().setArrangement({
          ...DEFAULT_ARRANGEMENT,
          minimapSide: "left",
        });
      });
      renderPanel();
      await goToSurfaceTab(user, "chat");

      // The revert after the name is the row's changed signal; it draws no dot.
      expect(within(row("minimap")).queryByTestId("changed-dot")).toBeNull();

      await user.click(
        within(row("minimap")).getByRole("button", { name: "Revert Minimap" }),
      );

      expect(useLayoutStore.getState().arrangement.minimapSide).toBe(
        DEFAULT_ARRANGEMENT.minimapSide,
      );
    });
  });

  it("lands a deep link on its region's row, switching to its tab and opening the disclosure", async () => {
    // The door's width-gate redirect goes through the modal bridge, so a
    // landing needs a published Settings surface to be redirected to.
    setSystemTabModalApi({
      active: null,
      openSettings: vi.fn(),
      openHistory: vi.fn(),
      close: vi.fn(),
      setSection: vi.fn(),
      promoteToTab: vi.fn(),
      isOverlayActive: () => true,
    });
    renderPanel();
    // The page opens on Presets, and `contextUsage` lives on Chat - the
    // landing has to switch tabs itself (G6), not just open a disclosure.
    expect(
      screen
        .getByRole("tab", { name: "Presets" })
        .getAttribute("aria-selected"),
    ).toBe("true");

    await act(async () => {
      navigateToLayoutRegion("contextUsage");
      await Promise.resolve();
    });

    expect(
      screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      within(row("contextUsage")).getByRole("radiogroup", {
        name: "Chip style",
      }),
    ).toBeTruthy();
    // The scroll is for the eye; the focus is for the hands (5.9).
    expect(row("contextUsage").querySelector("[data-row-grab]")).toBe(
      document.activeElement,
    );
  });

  it("lands a provider-row link on that provider's own row inside Usage limits, not on the region's row (U5)", async () => {
    setSystemTabModalApi({
      active: null,
      openSettings: vi.fn(),
      openHistory: vi.fn(),
      close: vi.fn(),
      setSection: vi.fn(),
      promoteToTab: vi.fn(),
      isOverlayActive: () => true,
    });
    renderPanel();
    const provider = USAGE_PROVIDER_IDS[0];

    await act(async () => {
      navigateToLayoutRegionRow("usageLimits", provider);
      await Promise.resolve();
    });

    expect(
      screen
        .getByRole("tab", { name: "Usage and resources" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    const landed = row("usageLimits").querySelector(
      `[data-sortable-id="${provider}"]`,
    );
    if (!(landed instanceof HTMLElement)) throw new Error("no provider row");
    expect(landed.getAttribute("data-settings-anchor-flash")).toBe("true");
    expect(landed.contains(document.activeElement)).toBe(true);
    expect(
      row("usageLimits").getAttribute("data-settings-anchor-flash"),
    ).toBeNull();
  });

  it("falls back to the region's own row when the provider row is not drawn, rather than consuming the landing with nothing shown", async () => {
    setSystemTabModalApi({
      active: null,
      openSettings: vi.fn(),
      openHistory: vi.fn(),
      close: vi.fn(),
      setSection: vi.fn(),
      promoteToTab: vi.fn(),
      isOverlayActive: () => true,
    });
    renderPanel();

    await act(async () => {
      // No provider the usage readings list has this id.
      navigateToLayoutRegionRow("usageLimits", "not-a-listed-provider");
      await Promise.resolve();
    });

    const section = row("usageLimits");
    expect(section.getAttribute("data-settings-anchor-flash")).toBe("true");
    // The section's stop is its Show switch, as a plain region landing's is.
    expect(section.querySelector("[data-region-show]")).toBe(
      document.activeElement,
    );
  });

  it("opens a row on a click, but never touches the editor's own selection (item toggleRow)", async () => {
    // This page keeps its own local `openRows` state (`layout-settings-panel.tsx`'s
    // `useState`), never the editor store's - the editor's `selected` is a
    // fact about the DOCKED inspector, which this page is not.
    const user = userEvent.setup();
    renderPanel();
    await goToSurfaceTab(user, "chat");

    await user.click(within(row("contextUsage")).getByRole("button"));

    expect(
      within(row("contextUsage")).getByRole("radiogroup", {
        name: "Chip style",
      }),
    ).toBeTruthy();
    expect(useLayoutEditorStore.getState().selected).toBeNull();
  });

  it("gives a non-disclosing row no aria-pressed here, and a click on it does nothing (item C)", async () => {
    // Home tab has no disclosure at all (`rows: []`) - in the editor its label
    // button selects it (`onSelectRow`), but this page passes `onSelectRow={null}`,
    // so the same button here is inert and never claims to be a toggle.
    const user = userEvent.setup();
    renderPanel();
    await goToSurfaceTab(user, "topBar");

    const button = within(row("homeTab")).getByRole("button");
    expect(button.hasAttribute("aria-pressed")).toBe(false);

    await user.click(button);

    expect(button.hasAttribute("aria-pressed")).toBe(false);
    expect(useLayoutEditorStore.getState().selected).toBeNull();
  });

  it("picks the area an editor exit lands on, with no row touched (5.3)", async () => {
    setSystemTabModalApi({
      active: null,
      openSettings: vi.fn(),
      openHistory: vi.fn(),
      close: vi.fn(),
      setSection: vi.fn(),
      promoteToTab: vi.fn(),
      isOverlayActive: () => true,
    });
    renderPanel();
    expect(
      screen
        .getByRole("tab", { name: "Presets" })
        .getAttribute("aria-selected"),
    ).toBe("true");

    await act(async () => {
      navigateToLayoutArea("composer");
      await Promise.resolve();
    });

    expect(
      screen
        .getByRole("tab", { name: "Composer" })
        .getAttribute("aria-selected"),
    ).toBe("true");

    await act(async () => {
      navigateToLayoutArea(null);
      await Promise.resolve();
    });

    expect(
      screen
        .getByRole("tab", { name: "Presets" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  describe("the small-screen status bar row (L-51)", () => {
    it("is absent while the phone layout is not drawn", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "statusBar");

      expect(
        screen.queryByRole("switch", {
          name: "Status bar on small screens",
        }),
      ).toBeNull();
    });

    // The switch the phone layout's footer mounts from exists wherever that
    // layout is drawn: the installed app, which draws it at every width, and
    // a browser tab narrow enough to.
    it.each([
      { where: "the installed mobile app", installed: true },
      { where: "a narrow browser tab", installed: false },
    ])("writes the arrangement in $where", async ({ installed }) => {
      setMobileApp(installed);
      setPhoneLayoutOnly(true);
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "statusBar");

      await user.click(
        screen.getByRole("switch", {
          name: "Status bar on small screens",
        }),
      );

      expect(useLayoutStore.getState().arrangement.mobileFooter).toBe(true);
    });
  });

  describe("the surface placement rows", () => {
    it("labels the Tabs tab, and opens it with Placement then Tab overflow", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "topBar");

      const tabs = surface("topBar");
      const position = tabs.querySelector(
        "[data-settings-anchor='layout-tab-strip-placement']",
      );
      const taskTabLayout = tabs.querySelector(
        "[data-settings-anchor='layout-task-tab-layout']",
      );
      if (position === null || taskTabLayout === null) {
        throw new Error("missing a Tabs surface row");
      }
      expect(position.textContent).toContain("Placement");
      expect(
        position.compareDocumentPosition(taskTabLayout) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        within(tabs).getByRole("radiogroup", { name: "Tab placement" }),
      ).toBeTruthy();
    });

    it("disables Tab overflow with its reason while the tabs are vertical, keeping its value", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "topBar");
      const taskTabLayout = within(surface("topBar")).getByRole("radiogroup", {
        name: "Tab overflow",
      });
      // Off by the row's own disabled group, which `:disabled` reads and the
      // button's `disabled` attribute does not.
      const disabledStates = (): ReadonlyArray<boolean> =>
        within(taskTabLayout)
          .getAllByRole<HTMLButtonElement>("radio")
          .map((radio) => radio.matches(":disabled"));
      expect(disabledStates()).toEqual([false, false]);

      await user.click(
        within(
          screen.getByRole("radiogroup", { name: "Tab placement" }),
        ).getByRole("radio", { name: "Left" }),
      );

      expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
        "left",
      );
      expect(disabledStates()).toEqual([true, true]);
      const reason = within(surface("topBar")).getByText(
        "Set Placement to Top to use this.",
      );
      expect(reason.getAttribute("data-row-availability")).toBe("disabled");
      expect(
        taskTabLayout.closest("fieldset")?.getAttribute("aria-describedby"),
      ).toBe(reason.id);
      expect(
        within(taskTabLayout)
          .getByRole("radio", { name: "Scroll" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });

    it("opens the Tabs tab with Side tab view, disabled at the top and writable once vertical (D8)", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "topBar");

      const tabs = surface("topBar");
      const view = tabs.querySelector(
        "[data-settings-anchor='layout-side-strip-view']",
      );
      expect(view?.textContent).toContain("Side tab view");
      const viewGroup = within(tabs).getByRole("radiogroup", {
        name: "Side tab view",
      });
      expect(
        within(viewGroup)
          .getAllByRole<HTMLButtonElement>("radio")
          .every((option) => option.disabled),
      ).toBe(true);
      const reason = within(tabs).getByText(
        "Set Placement to Left or Right to use this.",
      );
      expect(reason.getAttribute("data-row-availability")).toBe("disabled");
      expect(
        viewGroup.closest("fieldset")?.getAttribute("aria-describedby"),
      ).toBe(reason.id);

      await user.click(
        within(
          screen.getByRole("radiogroup", { name: "Tab placement" }),
        ).getByRole("radio", { name: "Left" }),
      );

      expect(
        within(viewGroup)
          .getAllByRole<HTMLButtonElement>("radio")
          .every((option) => option.disabled),
      ).toBe(false);
      await user.click(
        within(viewGroup).getByRole("radio", { name: "Tabs and agents" }),
      );

      expect(useLayoutStore.getState().arrangement.sideStripView).toBe(
        "activity",
      );
    });

    it("opens the Sidebar tab with Side, which writes the sidebar's side", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "sidebar");

      const sidebar = surface("sidebar");
      const side = sidebar.querySelector(
        "[data-settings-anchor='layout-sidebar-side']",
      );
      expect(side?.textContent).toContain("Side");
      await user.click(
        within(
          within(sidebar).getByRole("radiogroup", { name: "Sidebar side" }),
        ).getByRole("radio", { name: "Right" }),
      );

      expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("right");
    });

    it("withholds the desktop-only rows and the editor door in the installed mobile app", async () => {
      // The installed app is the phone layout at every width.
      setMobileApp(true);
      setPhoneLayoutOnly(true);
      useLayoutStore.setState({
        ...DEFAULT_LAYOUT_SNAPSHOT,
        arrangement: {
          ...DEFAULT_LAYOUT_SNAPSHOT.arrangement,
          tabStripPlacement: "left",
        },
      });
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "topBar");

      expect(
        screen.queryByRole("radiogroup", { name: "Tab placement" }),
      ).toBeNull();
      expect(
        screen.queryByRole("radiogroup", { name: "Side tab view" }),
      ).toBeNull();
      // No tab strip on the phone, so nothing for overflow to fit.
      expect(
        screen.queryByRole("radiogroup", { name: "Tab overflow" }),
      ).toBeNull();
      // No window there is ever wide enough, so neither the button nor the
      // "needs a wider window" line that stands in for it.
      expect(
        screen.queryByRole("button", { name: "Customize layout" }),
      ).toBeNull();
      expect(document.body.textContent).not.toContain(
        "The editor needs a wider window",
      );

      // Each of the rest lives on a different tab, so it has to be checked on
      // ITS tab - on topBar's it would read as absent whether or not the
      // mobile-app guard withheld it.
      await goToSurfaceTab(user, "sidebar");
      expect(
        screen.queryByRole("radiogroup", { name: "Sidebar side" }),
      ).toBeNull();
      expect(
        screen.queryByRole("switch", { name: "Readings on agent rows" }),
      ).toBeNull();
      await goToSurfaceTab(user, "chat");
      expect(
        screen.queryByRole("radiogroup", { name: "Reading width" }),
      ).toBeNull();
      // The phone's minimap is a bottom drawer that ignores the region, so
      // there is no row to show it by (and no Side to pick): nothing at all.
      expect(
        surface("chat").querySelector('[data-sortable-id="minimap"]'),
      ).toBeNull();
      expect(
        screen.queryByRole("radiogroup", { name: "Minimap side" }),
      ).toBeNull();
    });

    it("says what the Home tab still decides on a phone, which has no tab strip", async () => {
      setPhoneLayoutOnly(true);
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "topBar");
      const row = surface("topBar").querySelector(
        '[data-sortable-id="homeTab"]',
      );
      if (!(row instanceof HTMLElement)) throw new Error("no Home tab row");

      await user.click(within(row).getByRole("button", { name: /^Home tab/ }));

      expect(row.textContent).toContain("Adds Home to the menu");
    });

    it.each(["vertical tabs", "side tabs"])(
      "finds Position when searching %s",
      (query) => {
        const anchors = searchSettings(query, {
          runnerHost: null,
          featureSettings: null,
          mobileApp: false,
          phoneLayout: false,
        }).map((result) => result.entry.anchor);

        expect(anchors).toContain("layout-tab-strip-placement");
      },
    );

    it.each(["activity", "live agents", "needs you"])(
      "finds View when searching %s (D8)",
      (query) => {
        const anchors = searchSettings(query, {
          runnerHost: null,
          featureSettings: null,
          mobileApp: false,
          phoneLayout: false,
        }).map((result) => result.entry.anchor);

        expect(anchors).toContain("layout-side-strip-view");
      },
    );
  });

  describe("tab navigation (G6)", () => {
    it("shows only the active surface's rows, hiding every other tab's", async () => {
      const user = userEvent.setup();
      renderPanel();

      for (const group of SURFACE_GROUPS) {
        await goToSurfaceTab(user, group.id);
        expect(tabPanelHiddenFor(`layout-surface-${group.id}`)).toBe(false);
        expect(tabPanelHiddenFor("layout-presets-group")).toBe(true);
        for (const other of SURFACE_GROUPS) {
          if (other.id === group.id) continue;
          expect(
            tabPanelHiddenFor(`layout-surface-${other.id}`),
            other.id,
          ).toBe(true);
        }
      }

      // Back on Presets, no surface's content is visible.
      await user.click(
        screen.getByRole("tab", { name: LAYOUT.definitions.presets.label }),
      );
      expect(tabPanelHiddenFor("layout-presets-group")).toBe(false);
      for (const group of SURFACE_GROUPS) {
        expect(tabPanelHiddenFor(`layout-surface-${group.id}`)).toBe(true);
      }
    });
  });

  describe("settings-search anchor landing (G6)", () => {
    it("switches to a row's own tab when a search result asks to land on it", () => {
      // Seeded before the panel mounts, the way a search-result click's
      // request outlives the navigation that made it (5.9).
      useSettingsSearchStore
        .getState()
        .requestReveal("layout", LAYOUT.definitions.sidebarSide.anchor);

      renderPanel();

      expect(
        screen
          .getByRole("tab", { name: "Sidebar" })
          .getAttribute("aria-selected"),
      ).toBe("true");
      expect(tabPanelHiddenFor("layout-surface-sidebar")).toBe(false);
      // Presets, the page's own default, is not what's showing.
      expect(tabPanelHiddenFor("layout-presets-group")).toBe(true);
    });
  });

  describe("the area rail (H2)", () => {
    it("shows exactly one area's panel at a time", async () => {
      const user = userEvent.setup();
      renderPanel();

      expect(
        document.querySelectorAll('[role="tabpanel"]:not([hidden])'),
      ).toHaveLength(1);
      expect(activeTabPanel()).toBe(
        screen.getByTestId("layout-presets-group").closest('[role="tabpanel"]'),
      );

      await goToSurfaceTab(user, "chat");

      expect(
        document.querySelectorAll('[role="tabpanel"]:not([hidden])'),
      ).toHaveLength(1);
      expect(activeTabPanel()).toBe(
        surface("chat").closest('[role="tabpanel"]'),
      );
    });

    it("walks the rail with arrow keys, Home and End (Radix roving focus)", async () => {
      renderPanel();
      const tabs = screen.getAllByRole("tab");
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        "Presets",
        "Task tabs",
        "Sidebar",
        "Chat",
        "Composer",
        "Usage and resources",
      ]);

      // Radix moves the roving tab stop on a `setTimeout(0)` rather than
      // synchronously in the keydown handler, so every press needs a
      // macrotask flush before the new `document.activeElement` is read.
      async function press(key: string): Promise<void> {
        fireEvent.keyDown(document.activeElement ?? tabs[0], { key });
        await act(async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 0);
          });
        });
      }

      act(() => {
        tabs[0].focus();
      });

      await press("ArrowDown");
      expect(document.activeElement).toBe(tabs[1]);
      expect(tabs[1].getAttribute("aria-selected")).toBe("true");

      await press("End");
      expect(document.activeElement).toBe(tabs[tabs.length - 1]);
      expect(tabs[tabs.length - 1].getAttribute("aria-selected")).toBe("true");

      await press("Home");
      expect(document.activeElement).toBe(tabs[0]);
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");

      await press("ArrowDown");
      await press("ArrowUp");
      expect(document.activeElement).toBe(tabs[0]);
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    });

    it("puts the editor door in the page header, with its search anchor, and draws no Customize card", () => {
      renderPanel();

      const anchor = document.querySelector(
        `[data-settings-anchor="${LAYOUT.definitions.customizeEntry.anchor}"]`,
      );
      expect(anchor).not.toBeNull();
      expect(anchor?.textContent).toMatch(
        /Open the editor|needs a wider window/,
      );
      expect(screen.queryByText("Customize layout")).toBeNull();
    });

    it("lights an area's dot after an edit, independently of every other area's", () => {
      act(() => {
        useLayoutStore.getState().setArrangement({
          ...DEFAULT_ARRANGEMENT,
          minimapSide: "left", // chat
          sidebarSide: "right", // sidebar
        });
      });
      renderPanel();

      const chatTab = () => screen.getByRole("tab", { name: /^Chat/ });
      const sidebarTab = () => screen.getByRole("tab", { name: /^Sidebar/ });
      const composerTab = () => screen.getByRole("tab", { name: /^Composer/ });
      expect(within(chatTab()).getByTestId("area-changed-dot")).toBeTruthy();
      expect(within(sidebarTab()).getByTestId("area-changed-dot")).toBeTruthy();
      expect(
        within(composerTab()).queryByTestId("area-changed-dot"),
      ).toBeNull();
    });

    it("scrolls a newly picked area back to its top", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "chat");

      const chatBody = surface("chat").closest("[data-layout-area-body]");
      if (!(chatBody instanceof HTMLElement)) {
        throw new Error("no scroll body for chat");
      }
      chatBody.scrollTop = 100;

      await goToSurfaceTab(user, "composer");
      await goToSurfaceTab(user, "chat");

      expect(chatBody.scrollTop).toBe(0);
    });
  });

  describe("the header's door into the editor", () => {
    const originalInnerWidth = window.innerWidth;

    // The door is withheld under the editor's own 1100px threshold
    // (`LAYOUT_EDITOR_MIN_WIDTH`), which jsdom's default width is below.
    beforeEach(() => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: 1400,
      });
    });
    afterEach(() => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: originalInnerWidth,
      });
    });

    it("opens with origin settings/presets (area null) at rest", () => {
      renderPanel();

      fireEvent.click(screen.getByRole("button", { name: "Customize layout" }));

      expect(openLayoutEditorMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          source: "direct_ui",
          entry: "pointer",
          target: null,
          origin: { kind: "settings", area: null },
        }),
      );
    });

    describe("while another window holds the editor (T6)", () => {
      beforeEach(() => {
        useLayoutEditorStore.setState({ lockedBy: "other-window" });
      });
      afterEach(() => {
        useLayoutEditorStore.setState({ lockedBy: "none" });
      });

      it("is disabled with the reason beside it, and a press opens nothing", () => {
        renderPanel();

        const button = screen.getByRole("button", { name: "Customize layout" });

        expect(button.matches(":disabled")).toBe(true);
        const reasonId = button.getAttribute("aria-describedby");
        expect(reasonId).not.toBeNull();
        expect(
          reasonId === null
            ? null
            : document.getElementById(reasonId)?.textContent,
        ).toBe("Open in another window. Your layout is saved there.");

        fireEvent.click(button);
        expect(openLayoutEditorMock).not.toHaveBeenCalled();
      });

      it("is plain again once the lease is released", () => {
        useLayoutEditorStore.setState({ lockedBy: "none" });
        renderPanel();

        const button = screen.getByRole("button", { name: "Customize layout" });

        expect(button.matches(":disabled")).toBe(false);
        expect(button.getAttribute("aria-describedby")).toBeNull();
      });
    });

    it("names the current surface tab as the origin's area", async () => {
      const user = userEvent.setup();
      renderPanel();
      await goToSurfaceTab(user, "sidebar");

      fireEvent.click(screen.getByRole("button", { name: "Customize layout" }));

      expect(openLayoutEditorMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          origin: { kind: "settings", area: "sidebar" },
        }),
      );
    });
  });

  describe("the phone's area select says which areas changed (H2)", () => {
    // jsdom draws the rail AND the select (nothing here applies `md:hidden`),
    // so the select is read as it is on a phone without a viewport to fake.
    // `browser-tests/layout-settings.spec.ts` keeps the real-pointer pick;
    // what the trigger and the open list SAY is decided by the markup, which
    // is this file's.
    function areaSelect(): HTMLElement {
      return screen.getByRole("combobox", { name: "Layout area" });
    }

    function changeChat(): void {
      act(() => {
        useLayoutStore.getState().setArrangement({
          ...DEFAULT_ARRANGEMENT,
          minimapSide: "left", // Chat
        });
      });
    }

    it("draws the dot and says ', changed' on the trigger only while the picked area differs", async () => {
      const user = userEvent.setup();
      changeChat();
      renderPanel();

      await goToSurfaceTab(user, "chat");
      expect(within(areaSelect()).getByTestId("area-changed-dot")).toBeTruthy();
      expect(areaSelect().textContent).toContain(", changed");

      // The dot follows the picked area, not the page: Composer is untouched.
      await goToSurfaceTab(user, "composer");
      expect(within(areaSelect()).queryByTestId("area-changed-dot")).toBeNull();
      expect(areaSelect().textContent).not.toContain(", changed");
    });

    it("marks, in the open list, exactly the areas that changed - by the dot and in words", () => {
      changeChat();
      renderPanel();

      fireEvent.keyDown(areaSelect(), { key: "ArrowDown" });

      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(SURFACE_GROUPS.length + 1);
      const marked = options
        .filter(
          (option) =>
            option.textContent.includes(", changed") &&
            option.querySelector('[data-testid="area-changed-dot"]') !== null,
        )
        .map((option) => option.querySelector(".truncate")?.textContent);
      // Presets reads as changed only while a VALUE differs from the shipped
      // preset (its own summary says "Modified"): a placement is not one a
      // preset puts back (T5), so a moved minimap marks Chat alone.
      expect(marked).toEqual(["Chat"]);
    });

    it("keeps focus inside the area's panel when Enter on a changed row's revert puts the row back", async () => {
      const user = userEvent.setup();
      changeChat();
      renderPanel();
      await goToSurfaceTab(user, "chat");
      const revert = within(activeTabPanel()).getByRole("button", {
        name: "Revert Minimap",
      });
      act(() => {
        revert.focus();
      });
      expect(document.activeElement).toBe(revert);

      await user.keyboard("{Enter}");

      expect(
        within(activeTabPanel()).queryByRole("button", {
          name: "Revert Minimap",
        }),
      ).toBeNull();
      expect(useLayoutStore.getState().arrangement.minimapSide).toBe(
        DEFAULT_ARRANGEMENT.minimapSide,
      );
      // The revert unmounted with the change it undid; focus must not have
      // fallen to the page with it.
      expect(document.activeElement).not.toBe(document.body);
      expect(activeTabPanel().contains(document.activeElement)).toBe(true);
    });
  });

  describe("a landing marks its row, and the marks retire (H2)", () => {
    // The retired CDP driver read `data-settings-anchor-flash` beside the
    // row's place in the pane. The place needs layout and stays a browser
    // claim (`browser-tests/layout-settings.spec.ts`); the
    // mark, its retirement and the composition of the two landing doors with
    // the pane's tabs are decided here.
    const ANCHOR = LAYOUT.definitions.sidebarSide.anchor;

    beforeEach(() => {
      vi.useFakeTimers();
      Object.defineProperty(Element.prototype, "checkVisibility", {
        configurable: true,
        value: function checkVisibility(this: Element): boolean {
          return this.closest("[hidden]") === null;
        },
      });
    });
    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(Element.prototype, "checkVisibility");
    });

    function Page(): ReactNode {
      useSettingsAnchorReveal("layout");
      return <LayoutSettingsPanel />;
    }

    function flashed(): ReadonlyArray<Element> {
      return [...document.querySelectorAll("[data-settings-anchor-flash]")];
    }

    it("a deep link to a region marks its row, keeps the mark while it reads, then retires it", async () => {
      setSystemTabModalApi({
        active: null,
        openSettings: vi.fn(),
        openHistory: vi.fn(),
        close: vi.fn(),
        setSection: vi.fn(),
        promoteToTab: vi.fn(),
        isOverlayActive: () => true,
      });
      renderPanel();

      await act(async () => {
        navigateToLayoutRegion("contextUsage");
        await Promise.resolve();
      });

      expect(flashed()).toEqual([row("contextUsage")]);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(flashed()).toEqual([row("contextUsage")]);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(flashed()).toEqual([]);
    });

    it("a search result marks its row in the area it switched to, never the hidden one it started from", () => {
      render(<Page />);
      expect(tabPanelHiddenFor("layout-surface-sidebar")).toBe(true);

      act(() => {
        useSettingsSearchStore.getState().requestReveal("layout", ANCHOR);
      });
      act(() => {
        vi.advanceTimersByTime(16);
      });

      const marked = flashed();
      expect(marked).toHaveLength(1);
      expect(marked[0].getAttribute("data-settings-anchor")).toBe(ANCHOR);
      expect(marked[0].closest('[role="tabpanel"]')).toBe(activeTabPanel());
      expect(marked[0].closest("[hidden]")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(flashed()).toEqual([]);
    });
  });
});
