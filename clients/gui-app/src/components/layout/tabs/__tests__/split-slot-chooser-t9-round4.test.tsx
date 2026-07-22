/**
 * T9 round-4: real `SplitSlotChooserContent` render coverage for MED1 and
 * MED2. Round 1-3 tests called `getFillableSlotChoicesWithCatalog` as a bare
 * function and asserted on its return array - never rendering the chooser
 * component itself, so a bug in the render/DOM-filtering layer (or a fix
 * that only "worked" when read as an array) would slip through. These tests
 * render the real chooser content component and assert on the actual DOM.
 */
import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  SplitSlotChooserContent,
  type SplitSlotChooserProps,
} from "@/components/layout/tabs/split-slot-chooser";
import type { FillableSlotCatalogEntry } from "@/components/layout/tabs/fillable-slot";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import {
  registerTabStructuralLockPredicate,
  resetTabStructuralLockForTesting,
} from "@/stores/tabs/tab-structural-lock";
import type { TabRef } from "@/stores/tabs/types";

async function renderChooser(
  props: SplitSlotChooserProps & {
    readonly catalog: ReadonlyArray<FillableSlotCatalogEntry>;
  },
): Promise<void> {
  const rootRoute = createRootRoute({
    component: () => (
      <SplitSlotChooserContent
        {...props}
        query=""
        onQueryChange={() => undefined}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  // Confirms the component actually mounted before any absence assertion -
  // otherwise `queryByRole(...) === null` would trivially pass on an empty
  // (not-yet-resolved-router) DOM.
  await screen.findByLabelText("Search tabs and destinations");
}

afterEach(() => {
  cleanup();
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  resetTabStructuralLockForTesting();
});

describe("T9 round-4: SplitSlotChooserContent real render", () => {
  it("hides a structurally locked Phase-migration catalog row (MED1)", async () => {
    const PHASE: TabRef = { kind: "epic", id: "phase-tab" };
    useEpicCanvasStore.getState().openEpicTabWithId(PHASE.id, "phase-1", "");
    useEpicCanvasStore.setState((state) => {
      const tab = state.tabsById[PHASE.id];
      if (tab === undefined) throw new Error("Expected Phase tab");
      return {
        tabsById: {
          ...state.tabsById,
          [PHASE.id]: {
            ...tab,
            surfaceMode: { kind: "phase-migration", phaseId: "phase-1" },
          },
        },
      };
    });
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-a",
          left: { kind: "empty" },
          right: { kind: "tab", ref: PHASE },
          focusedSide: "left",
          routeBackingSide: "right",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-a",
      stripOrder: [PHASE],
      systemTabs: { history: null, settings: null },
    });
    const unregister = registerTabStructuralLockPredicate(
      (ref) => ref.kind === PHASE.kind && ref.id === PHASE.id,
    );

    await renderChooser({
      splitId: "split-a",
      side: "left",
      slot: { kind: "empty" },
      focused: false,
      catalog: [
        { kind: "phase-migration", phaseId: "phase-1", name: "Legacy Phase" },
      ],
    });

    expect(screen.queryByRole("button", { name: "Legacy Phase" })).toBeNull();
    unregister();
  });

  it("shows an unlocked Phase-migration catalog row normally", async () => {
    const PHASE: TabRef = { kind: "epic", id: "phase-tab" };
    useEpicCanvasStore.getState().openEpicTabWithId(PHASE.id, "phase-1", "");
    useEpicCanvasStore.setState((state) => {
      const tab = state.tabsById[PHASE.id];
      if (tab === undefined) throw new Error("Expected Phase tab");
      return {
        tabsById: {
          ...state.tabsById,
          [PHASE.id]: {
            ...tab,
            surfaceMode: { kind: "phase-migration", phaseId: "phase-1" },
          },
        },
      };
    });
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-a",
          left: { kind: "empty" },
          right: { kind: "tab", ref: PHASE },
          focusedSide: "left",
          routeBackingSide: "right",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-a",
      stripOrder: [PHASE],
      systemTabs: { history: null, settings: null },
    });

    await renderChooser({
      splitId: "split-a",
      side: "left",
      slot: { kind: "empty" },
      focused: false,
      catalog: [
        { kind: "phase-migration", phaseId: "phase-1", name: "Legacy Phase" },
      ],
    });

    expect(screen.getByRole("button", { name: "Legacy Phase" })).toBeDefined();
  });

  it("dedupes an Epic reachable both as an open ref and a catalog destination (MED2a)", async () => {
    const PARTNER: TabRef = { kind: "epic", id: "partner" };
    const REUSE: TabRef = { kind: "epic", id: "reuse" };
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(PARTNER.id, "shared-epic", "Partner");
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(REUSE.id, "shared-epic", "Partner Copy");
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-a",
          left: { kind: "empty" },
          right: { kind: "tab", ref: PARTNER },
          focusedSide: "left",
          routeBackingSide: "right",
          leftRatio: 0.5,
        },
        { kind: "tab", id: "tab:epic:reuse", ref: REUSE },
      ],
      activeItemId: "split-a",
      stripOrder: [PARTNER, REUSE],
      systemTabs: { history: null, settings: null },
    });

    await renderChooser({
      splitId: "split-a",
      side: "left",
      slot: { kind: "empty" },
      focused: false,
      catalog: [],
    });

    // The open-ref row (the reusable ungrouped view) is present under its
    // own label...
    expect(screen.getByRole("button", { name: "Partner Copy" })).toBeDefined();
    // ...and the same-Epic catalog destination row (keyed by Epic id, which
    // never collides with the open row's tab-id-keyed id) must NOT also
    // render - it is the same Epic, reachable twice.
    expect(screen.queryByRole("button", { name: "Partner" })).toBeNull();
  });

  it("does not offer a bogus Epic destination for an incomplete Phase-migration split (MED2b)", async () => {
    const PHASE: TabRef = { kind: "epic", id: "phase-tab" };
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(PHASE.id, "phase-1", "Legacy Phase Tab");
    useEpicCanvasStore.setState((state) => {
      const tab = state.tabsById[PHASE.id];
      if (tab === undefined) throw new Error("Expected Phase tab");
      return {
        tabsById: {
          ...state.tabsById,
          [PHASE.id]: {
            ...tab,
            surfaceMode: { kind: "phase-migration", phaseId: "phase-1" },
          },
        },
      };
    });
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-a",
          left: { kind: "empty" },
          right: { kind: "tab", ref: PHASE },
          focusedSide: "left",
          routeBackingSide: "right",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-a",
      stripOrder: [PHASE],
      systemTabs: { history: null, settings: null },
    });

    await renderChooser({
      splitId: "split-a",
      side: "left",
      slot: { kind: "empty" },
      focused: false,
      catalog: [],
    });

    expect(
      screen.queryByRole("button", { name: "Legacy Phase Tab" }),
    ).toBeNull();
  });
});
