import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  resolveUnpairedHeaderSource,
  resolveValidatedTopLevelTabDrop,
  stripPairTargetForIndex,
} from "@/components/layout/tabs/top-level-tab-dnd";
import {
  commitFillableSlotDestination,
  getFillableSlotChoices,
  getFillableSlotChoicesWithCatalog,
  resolveFillableSlotDestination,
} from "@/components/layout/tabs/fillable-slot";
import { SplitDivider } from "@/components/layout/tabs/split-divider";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { setTabSplitCompatibility } from "@/stores/tabs/tab-split-compatibility";
import { resolveTabSplitCommandAvailability } from "@/stores/tabs/tab-split-commands";
import {
  registerTabStructuralLockPredicate,
  resetTabStructuralLockForTesting,
} from "@/stores/tabs/tab-structural-lock";
import type { TabRef } from "@/stores/tabs/types";

const PARTNER: TabRef = { kind: "epic", id: "partner" };
const OPEN_DRAFT: TabRef = { kind: "draft", id: "draft-open" };

function seedSplitLayout() {
  useEpicCanvasStore
    .getState()
    .openEpicTabWithId(PARTNER.id, "partner-epic", "Partner");
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "split",
        id: "split-a",
        left: { kind: "unavailable", previousRef: PARTNER, label: "Lost Epic" },
        right: { kind: "tab", ref: PARTNER },
        focusedSide: "left",
        routeBackingSide: "right",
        leftRatio: 0.5,
      },
      { kind: "tab", id: "tab:draft:draft-open", ref: OPEN_DRAFT },
    ],
    activeItemId: "split-a",
    stripOrder: [PARTNER, OPEN_DRAFT],
    systemTabs: { history: null, settings: null },
  });
}

afterEach(() => {
  cleanup();
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  setTabSplitCompatibility(true);
  resetTabStructuralLockForTesting();
});

describe("T9 split interactions", () => {
  it("validates fill targets against the live active item, locks, and source identity", () => {
    const source: TabRef = { kind: "draft", id: "source" };
    const target: TabRef = { kind: "epic", id: "target" };
    const header = {
      kind: "header-tab" as const,
      stripItemId: "source-item",
      tabKind: source.kind,
      tabId: source.id,
      index: 0,
    };
    const fillLayout = {
      version: 2 as const,
      items: [
        { kind: "tab" as const, id: "source-item", ref: source },
        {
          kind: "split" as const,
          id: "split-target",
          left: {
            kind: "unavailable" as const,
            previousRef: target,
            label: "Lost",
          },
          right: { kind: "tab" as const, ref: target },
          focusedSide: "left" as const,
          routeBackingSide: "right" as const,
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-target",
      systemTabs: { history: null, settings: null },
    };
    const fill = {
      kind: "top-level-fillable-slot" as const,
      splitId: "split-target",
      side: "left" as const,
    };
    expect(resolveValidatedTopLevelTabDrop(header, fill, fillLayout)).toEqual({
      source,
      target: fill,
    });
    // The slot must belong to the ACTIVE item.
    expect(
      resolveValidatedTopLevelTabDrop(header, fill, {
        ...fillLayout,
        activeItemId: "source-item",
      }),
    ).toBeNull();
    // A structurally locked SOURCE cannot fill a slot.
    const unregister = registerTabStructuralLockPredicate(
      (ref) => ref.kind === source.kind && ref.id === source.id,
    );
    expect(
      resolveValidatedTopLevelTabDrop(header, fill, fillLayout),
    ).toBeNull();
    unregister();
  });

  it("resolves a pair target from the live strip and refuses split items", () => {
    const target: TabRef = { kind: "epic", id: "target" };
    const layout = {
      version: 2 as const,
      items: [
        { kind: "tab" as const, id: "target-item", ref: target },
        {
          kind: "split" as const,
          id: "split-b",
          left: { kind: "tab" as const, ref: PARTNER },
          right: { kind: "empty" as const },
          focusedSide: "left" as const,
          routeBackingSide: "left" as const,
          leftRatio: 0.5,
        },
      ],
      activeItemId: "target-item",
      systemTabs: { history: null, settings: null },
    };

    expect(stripPairTargetForIndex(0, layout)).toEqual({
      kind: "top-level-strip-pair",
      targetRef: target,
    });
    // An existing group already owns two strip entries; it cannot absorb a third.
    expect(stripPairTargetForIndex(1, layout)).toBeNull();
    expect(stripPairTargetForIndex(7, layout)).toBeNull();
  });

  it("accepts a pair drop onto a background tab but refuses self, grouped and locked targets", () => {
    const source: TabRef = { kind: "draft", id: "source" };
    const target: TabRef = { kind: "epic", id: "target" };
    const header = {
      kind: "header-tab" as const,
      stripItemId: "source-item",
      tabKind: source.kind,
      tabId: source.id,
      index: 0,
    };
    const layout = {
      version: 2 as const,
      items: [
        { kind: "tab" as const, id: "source-item", ref: source },
        { kind: "tab" as const, id: "target-item", ref: target },
      ],
      // Deliberately NOT the target: unlike an edge split, pairing is how you
      // combine with a tab you are not currently looking at.
      activeItemId: "source-item",
      systemTabs: { history: null, settings: null },
    };
    const pair = {
      kind: "top-level-strip-pair" as const,
      targetRef: target,
    };

    expect(resolveValidatedTopLevelTabDrop(header, pair, layout)).toEqual({
      source,
      target: pair,
    });
    expect(
      resolveValidatedTopLevelTabDrop(
        header,
        { ...pair, targetRef: source },
        layout,
      ),
    ).toBeNull();
    expect(
      resolveValidatedTopLevelTabDrop(header, pair, {
        ...layout,
        items: [
          { kind: "tab" as const, id: "source-item", ref: source },
          {
            kind: "split" as const,
            id: "split-target",
            left: { kind: "tab" as const, ref: target },
            right: { kind: "empty" as const },
            focusedSide: "left" as const,
            routeBackingSide: "left" as const,
            leftRatio: 0.5,
          },
        ],
      }),
    ).toBeNull();

    const unregister = registerTabStructuralLockPredicate(
      (ref) => ref.kind === target.kind && ref.id === target.id,
    );
    expect(resolveValidatedTopLevelTabDrop(header, pair, layout)).toBeNull();
    unregister();
  });

  it("shows descriptor catalog Epic and legacy Phase destinations after reusable open refs", () => {
    seedSplitLayout();
    useLandingDraftStore.getState().createDraftWithId(OPEN_DRAFT.id, null);

    const choices = getFillableSlotChoicesWithCatalog("split-a", "left", [
      { kind: "epic", epicId: "unopened-epic", name: "Unopened Epic" },
      {
        kind: "phase-migration",
        phaseId: "phase-1",
        name: "Legacy Phase",
      },
    ]);

    expect(choices[0]?.destination).toEqual({
      kind: "open-ref",
      ref: OPEN_DRAFT,
    });
    expect(choices.map((choice) => choice.label)).toEqual(
      expect.arrayContaining(["Unopened Epic", "Legacy Phase"]),
    );
  });

  it("offers the populated Epic as a destination without History catalog data", () => {
    seedSplitLayout();

    const choices = getFillableSlotChoicesWithCatalog("split-a", "left", []);

    expect(choices.map((choice) => choice.label)).toEqual([
      "History",
      "Settings",
      "Partner",
      "New Task",
    ]);
    expect(
      resolveFillableSlotDestination("split-a", "left", {
        kind: "epic",
        epicId: "partner-epic",
        name: "Partner",
      }),
    ).toEqual({
      kind: "create-epic",
      epicId: "partner-epic",
      name: "Partner",
    });
  });

  it("removes a structurally locked Phase ref from the chooser", () => {
    seedSplitLayout();
    const phase: TabRef = { kind: "epic", id: "phase" };
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(phase.id, "phase-1", "Phase");
    const phaseTab = useEpicCanvasStore.getState().tabsById[phase.id];
    if (phaseTab === undefined) throw new Error("Expected Phase tab");
    useEpicCanvasStore.setState((state) => ({
      tabsById: {
        ...state.tabsById,
        [phase.id]: {
          ...phaseTab,
          surfaceMode: { kind: "phase-migration", phaseId: "phase-1" },
        },
      },
    }));
    useTabsStore.setState((state) => ({
      items: [
        ...state.items,
        { kind: "tab", id: "tab:epic:phase", ref: phase },
      ],
      stripOrder: [...state.stripOrder, phase],
    }));
    const unregister = registerTabStructuralLockPredicate(
      (ref) => ref.kind === phase.kind && ref.id === phase.id,
    );

    const choices = getFillableSlotChoices("split-a", "left");

    expect(choices.map((choice) => choice.id)).not.toContain("open:epic:phase");
    expect(
      resolveFillableSlotDestination("split-a", "left", {
        kind: "phase-migration",
        phaseId: "phase-1",
        name: "Phase",
      }),
    ).toEqual({ kind: "invalid" });
    unregister();
  });

  it("reuses an ungrouped same-Epic view even when the populated partner has that Epic", () => {
    seedSplitLayout();
    const reuse: TabRef = { kind: "epic", id: "reuse" };
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(reuse.id, "partner-epic", "Partner reuse");
    useTabsStore.setState((state) => ({
      items: [
        ...state.items,
        { kind: "tab", id: "tab:epic:reuse", ref: reuse },
      ],
      stripOrder: [...state.stripOrder, reuse],
    }));

    expect(
      resolveFillableSlotDestination("split-a", "left", {
        kind: "epic",
        epicId: "partner-epic",
        name: "Partner reuse",
      }),
    ).toEqual({ kind: "fill", ref: reuse });
  });

  it("does not let a background tab's Add command mutate the focused tab", () => {
    const focused: TabRef = { kind: "draft", id: "focused" };
    const background: TabRef = { kind: "draft", id: "background" };
    useLandingDraftStore.getState().createDraftWithId(focused.id, null);
    useLandingDraftStore.getState().createDraftWithId(background.id, null);
    useTabsStore.setState({
      version: 2,
      items: [
        { kind: "tab", id: "tab:draft:focused", ref: focused },
        { kind: "tab", id: "tab:draft:background", ref: background },
      ],
      activeItemId: "tab:draft:focused",
      stripOrder: [focused, background],
      systemTabs: { history: null, settings: null },
    });

    expect(resolveTabSplitCommandAvailability(background).add).toBe(false);
    expect(resolveTabSplitCommandAvailability(null).add).toBe(true);
  });

  it("reuses an ungrouped open ref and consumes unavailable metadata only on commit", () => {
    seedSplitLayout();
    useLandingDraftStore.getState().createDraftWithId(OPEN_DRAFT.id, null);

    const before = resolveFillableSlotDestination("split-a", "left", {
      kind: "open-ref",
      ref: OPEN_DRAFT,
    });
    expect(before).toEqual({ kind: "fill", ref: OPEN_DRAFT });
    expect(useTabsStore.getState().items[0]).toMatchObject({
      kind: "split",
      left: { kind: "unavailable", label: "Lost Epic" },
    });

    const activate = vi.fn();
    commitFillableSlotDestination({
      splitId: "split-a",
      side: "left",
      destination: { kind: "open-ref", ref: OPEN_DRAFT },
      activateFocusedRef: activate,
    });

    const split = useTabsStore.getState().items[0];
    expect(split).toMatchObject({
      kind: "split",
      left: { kind: "tab", ref: OPEN_DRAFT },
      focusedSide: "left",
      routeBackingSide: "left",
    });
    expect(useTabsStore.getState().items).toHaveLength(1);
    expect(activate).toHaveBeenCalledWith(OPEN_DRAFT);
  });

  it("reorders a split atomically and rejects one of its members as a pair/fill source", () => {
    seedSplitLayout();
    useLandingDraftStore.getState().createDraftWithId(OPEN_DRAFT.id, null);

    expect(
      resolveUnpairedHeaderSource(
        {
          kind: "header-tab",
          stripItemId: "split-a",
          tabKind: "epic",
          tabId: PARTNER.id,
          index: 0,
        },
        {
          version: 2,
          items: useTabsStore.getState().items,
          activeItemId: useTabsStore.getState().activeItemId,
          systemTabs: useTabsStore.getState().systemTabs,
        },
      ),
    ).toBeNull();
    expect(
      tabCommandCoordinator.reorderStripItem({
        itemId: "split-a",
        targetIndex: 2,
      }),
    ).toBe(true);
    expect(useTabsStore.getState().items.map((item) => item.id)).toEqual([
      "tab:draft:draft-open",
      "split-a",
    ]);
    expect(useTabsStore.getState().items[1]).toMatchObject({
      kind: "split",
      left: { kind: "unavailable", label: "Lost Epic" },
      right: { kind: "tab", ref: PARTNER },
    });
  });

  it("commits divider ratio on release, restores on cancellation, resets on double click, and supports keyboard nudging", () => {
    seedSplitLayout();
    const host = document.createElement("div");
    const hostBoundsRef = { current: host };
    const onPreviewRatioChange = vi.fn();
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 100,
      right: 1000,
      width: 1000,
      height: 100,
      toJSON: () => ({}),
    });
    const view = render(
      <SplitDivider
        splitId="split-a"
        leftRatio={0.5}
        hostBoundsRef={hostBoundsRef}
        onPreviewRatioChange={onPreviewRatioChange}
      />,
    );
    const separator = screen.getByRole("separator", {
      name: "Resize split view",
    });
    const divider = screen.getByTestId("split-divider-split-a");
    expect(separator).toBe(divider);

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 800 });
    expect(onPreviewRatioChange).toHaveBeenLastCalledWith(0.8);
    fireEvent.pointerCancel(divider, { pointerId: 1, clientX: 800 });
    expect(useTabsStore.getState().items[0]).toMatchObject({ leftRatio: 0.5 });
    expect(onPreviewRatioChange).toHaveBeenLastCalledWith(null);

    fireEvent.pointerDown(divider, { pointerId: 2, clientX: 500 });
    fireEvent.pointerUp(divider, { pointerId: 2, clientX: 800 });
    expect(useTabsStore.getState().items[0]).toMatchObject({ leftRatio: 0.8 });
    view.rerender(
      <SplitDivider
        splitId="split-a"
        leftRatio={0.8}
        hostBoundsRef={hostBoundsRef}
        onPreviewRatioChange={onPreviewRatioChange}
      />,
    );
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(useTabsStore.getState().items[0]).toMatchObject({ leftRatio: 0.78 });
    view.rerender(
      <SplitDivider
        splitId="split-a"
        leftRatio={0.78}
        hostBoundsRef={hostBoundsRef}
        onPreviewRatioChange={onPreviewRatioChange}
      />,
    );
    fireEvent.doubleClick(divider);
    expect(useTabsStore.getState().items[0]).toMatchObject({ leftRatio: 0.5 });
    view.rerender(
      <SplitDivider
        splitId="split-a"
        leftRatio={0.5}
        hostBoundsRef={hostBoundsRef}
        onPreviewRatioChange={onPreviewRatioChange}
      />,
    );
    expect(separator.getAttribute("aria-valuetext")).toBe("Left view 50%");
  });
});
