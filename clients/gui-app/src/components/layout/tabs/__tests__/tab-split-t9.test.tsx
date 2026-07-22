import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  EDGE_SPLIT_DWELL_MS,
  EdgeSplitDwellMachine,
  type EdgeSplitTimer,
} from "@/components/layout/tabs/edge-split-dwell";
import {
  resolveUnpairedHeaderEdgeSource,
  resolveValidatedTopLevelTabDrop,
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

interface FakeTimers {
  readonly timers: EdgeSplitTimer;
  run: (id: number) => void;
  cleared: ReadonlyArray<number>;
}

function fakeTimers(): FakeTimers {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const cleared: number[] = [];
  return {
    timers: {
      set: (callback, timeout) => {
        expect(timeout).toBe(EDGE_SPLIT_DWELL_MS);
        nextId += 1;
        callbacks.set(nextId, callback);
        return nextId;
      },
      clear: (id) => {
        cleared.push(id);
        callbacks.delete(id);
      },
    },
    run: (id) => callbacks.get(id)?.(),
    cleared,
  };
}

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
  it("commits edge split only after an uninterrupted 400ms dwell and resets on target change or cancel", () => {
    expect(EDGE_SPLIT_DWELL_MS).toBe(400);
    const fake = fakeTimers();
    const states: string[] = [];
    const machine = new EdgeSplitDwellMachine(
      (state) => states.push(state.kind),
      fake.timers,
    );
    machine.setTargetValidator(() => true);
    const left = {
      kind: "top-level-edge-split" as const,
      targetRef: PARTNER,
      side: "left" as const,
    };
    const right = { ...left, side: "right" as const };

    machine.observe(left);
    expect(machine.getState().kind).toBe("armed");
    expect(machine.commit(left)).toBeNull();
    expect(machine.getState().kind).toBe("idle");

    machine.observe(left);
    machine.observe(right);
    fake.run(2);
    expect(machine.getState().kind).toBe("armed");
    fake.run(3);
    expect(machine.getState().kind).toBe("preview");
    expect(machine.commit(right)).toEqual(right);
    expect(machine.getState().kind).toBe("commit");
    machine.reset();

    expect(states).toEqual([
      "armed",
      "idle",
      "armed",
      "armed",
      "preview",
      "commit",
      "idle",
    ]);
    expect(fake.cleared).toContain(1);
  });

  it("withdraws a dwell preview when the live validator changes before the timer fires", () => {
    const fake = fakeTimers();
    let valid = true;
    const machine = new EdgeSplitDwellMachine(() => undefined, fake.timers);
    machine.setTargetValidator(() => valid);
    const target = {
      kind: "top-level-edge-split" as const,
      targetRef: PARTNER,
      side: "left" as const,
    };

    machine.observe(target);
    valid = false;
    machine.revalidate();

    expect(machine.getState().kind).toBe("idle");
    expect(machine.commit(target)).toBeNull();
  });

  it("validates edge and fill targets against the live active item, locks, and source identity", () => {
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
      activeItemId: "target-item",
      systemTabs: { history: null, settings: null },
    };
    const edge = {
      kind: "top-level-edge-split" as const,
      targetRef: target,
      side: "left" as const,
    };

    expect(resolveValidatedTopLevelTabDrop(header, edge, layout)).toEqual({
      source,
      target: edge,
    });
    expect(
      resolveValidatedTopLevelTabDrop(
        header,
        { ...edge, targetRef: source },
        layout,
      ),
    ).toBeNull();
    expect(
      resolveValidatedTopLevelTabDrop(header, edge, {
        ...layout,
        activeItemId: "source-item",
      }),
    ).toBeNull();

    const unregister = registerTabStructuralLockPredicate(
      (ref) => ref.kind === target.kind && ref.id === target.id,
    );
    expect(resolveValidatedTopLevelTabDrop(header, edge, layout)).toBeNull();
    unregister();

    const fillLayout = {
      ...layout,
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
    expect(
      resolveValidatedTopLevelTabDrop(header, fill, {
        ...fillLayout,
        activeItemId: "source-item",
      }),
    ).toBeNull();
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

  it("reorders a split atomically and rejects one of its members as an edge source", () => {
    seedSplitLayout();
    useLandingDraftStore.getState().createDraftWithId(OPEN_DRAFT.id, null);

    expect(
      resolveUnpairedHeaderEdgeSource(
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
