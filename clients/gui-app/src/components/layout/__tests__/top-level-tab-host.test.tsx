import "../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { LandingTerminalHost } from "@/components/home/terminal-panel/landing-terminal-host";
import {
  MAX_RETAINED_TOP_LEVEL_SURFACES,
  TopLevelTabHost,
} from "@/components/layout/top-level-tab-host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

vi.mock("@/components/epic-tabs/epic-surface", () => ({
  EpicSurface: (props: { readonly epicId: string; readonly tabId: string }) => (
    <input
      data-epic-id={props.epicId}
      data-testid={`epic-surface-body-${props.tabId}`}
      defaultValue={props.tabId}
    />
  ),
}));

vi.mock("@/components/home/landing-draft-surface", () => ({
  LandingDraftSurface: () => <div data-testid="draft-surface-body" />,
}));

vi.mock("@/components/epics/history-surface", () => ({
  HistorySurface: () => <div data-testid="history-surface-body" />,
}));

vi.mock("@/components/settings/settings-surface", () => ({
  SettingsSurface: () => <div data-testid="settings-surface-body" />,
}));

// The host wraps the panel in the gesture provider (the single live-value
// reader); project the draft the host resolved onto the provider so this test
// verifies the single-mount projection without the provider's live wiring.
vi.mock(
  "@/components/home/terminal-panel/landing-terminal-gesture-provider",
  () => ({
    LandingTerminalGestureProvider: (props: {
      readonly draftId: string | null;
      readonly children: ReactNode;
    }) => (
      <div data-draft-id={props.draftId ?? ""} data-testid="landing-terminal">
        {props.children}
      </div>
    ),
  }),
);
vi.mock("@/components/home/terminal-panel/landing-terminal-panel", () => ({
  LandingTerminalPanel: () => null,
}));

const EPIC_A: TabRef = { kind: "epic", id: "epic-a" };
const EPIC_B: TabRef = { kind: "epic", id: "epic-b" };
const DRAFT_A: TabRef = { kind: "draft", id: "draft-a" };
const DRAFT_B: TabRef = { kind: "draft", id: "draft-b" };
const HISTORY: TabRef = { kind: "history", id: "history" };
const SETTINGS: TabRef = { kind: "settings", id: "settings" };

function surfaceRef(key: TabRef): HTMLElement {
  return screen.getByTestId(`top-level-surface-${key.kind}-${key.id}`);
}

function seedSources(refs: ReadonlyArray<TabRef>): void {
  for (const ref of refs) {
    if (ref.kind === "epic") {
      useEpicCanvasStore
        .getState()
        .openEpicTabWithId(ref.id, ref.id, `Epic ${ref.id}`);
      continue;
    }
    if (ref.kind === "draft") {
      useLandingDraftStore.getState().createDraftWithId(ref.id, null);
    }
  }

  useTabsStore.setState((state) => ({
    ...state,
    systemTabs: {
      history: refs.some((ref) => ref.kind === "history")
        ? { id: "history", kind: "history", name: "History", lastPath: null }
        : null,
      settings: refs.some((ref) => ref.kind === "settings")
        ? {
            id: "settings",
            kind: "settings",
            name: "Settings",
            lastPath: null,
          }
        : null,
    },
  }));
}

function setSplit(left: TabRef, right: TabRef, focusedSide: "left" | "right") {
  useTabsStore.setState((state) => ({
    ...state,
    items: [
      {
        kind: "split",
        id: "pair",
        left: { kind: "tab", ref: left },
        right: { kind: "tab", ref: right },
        focusedSide,
        routeBackingSide: focusedSide,
        leftRatio: 0.5,
      },
    ],
    activeItemId: "pair",
    stripOrder: [left, right],
  }));
}

function setSplitAlongside(
  left: TabRef,
  right: TabRef,
  focusedSide: "left" | "right",
  refs: ReadonlyArray<TabRef>,
) {
  const paired = new Set([left.id, right.id]);
  useTabsStore.setState((state) => ({
    ...state,
    items: [
      {
        kind: "split",
        id: "pair",
        left: { kind: "tab", ref: left },
        right: { kind: "tab", ref: right },
        focusedSide,
        routeBackingSide: focusedSide,
        leftRatio: 0.5,
      },
      ...refs
        .filter((ref) => !paired.has(ref.id))
        .map((ref) => ({
          kind: "tab" as const,
          id: `tab:${ref.kind}:${ref.id}`,
          ref,
        })),
    ],
    activeItemId: "pair",
    stripOrder: refs,
  }));
}

function setSingle(ref: TabRef, refs: ReadonlyArray<TabRef>) {
  useTabsStore.setState((state) => ({
    ...state,
    items: refs.map((candidate) => ({
      kind: "tab" as const,
      id: `tab:${candidate.kind}:${candidate.id}`,
      ref: candidate,
    })),
    activeItemId: `tab:${ref.kind}:${ref.id}`,
    stripOrder: refs,
  }));
}

describe("<TopLevelTabHost />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  });

  it.each([
    ["Epic/Epic", EPIC_A, EPIC_B],
    ["Epic/draft", EPIC_A, DRAFT_A],
    ["Epic/History", EPIC_A, HISTORY],
    ["Epic/Settings", EPIC_A, SETTINGS],
    ["draft/draft", DRAFT_A, DRAFT_B],
    ["draft/History", DRAFT_A, HISTORY],
    ["draft/Settings", DRAFT_A, SETTINGS],
    ["History/Settings", HISTORY, SETTINGS],
  ])("renders %s as two visible slots", (_name, left, right) => {
    seedSources([left, right]);
    setSplit(left, right, "left");

    render(<TopLevelTabHost />);

    expect(surfaceRef(left).dataset.visible).toBe("true");
    expect(surfaceRef(left).dataset.focused).toBe("true");
    expect(surfaceRef(left).className).toContain("flex");
    expect(surfaceRef(left).className).toContain("h-full");
    expect(surfaceRef(left).className).toContain("flex-col");
    expect(surfaceRef(right).dataset.visible).toBe("true");
    expect(surfaceRef(right).dataset.focused).toBe("false");
  });

  it("keeps split partner keys mounted while swapping their slots", () => {
    seedSources([EPIC_A, DRAFT_A]);
    setSplit(EPIC_A, DRAFT_A, "left");
    render(<TopLevelTabHost />);

    const epicBefore = surfaceRef(EPIC_A);
    const draftBefore = surfaceRef(DRAFT_A);

    act(() => setSplit(DRAFT_A, EPIC_A, "right"));

    expect(surfaceRef(EPIC_A)).toBe(epicBefore);
    expect(surfaceRef(DRAFT_A)).toBe(draftBefore);
    expect(surfaceRef(EPIC_A).dataset.focused).toBe("true");
  });

  it("keeps a body instance and its local value across single-to-split-to-swap", async () => {
    seedSources([EPIC_A, DRAFT_A]);
    setSingle(EPIC_A, [EPIC_A, DRAFT_A]);
    render(<TopLevelTabHost />);

    const bodyBefore = await screen.findByTestId("epic-surface-body-epic-a");
    bodyBefore.setAttribute("data-local-value", "retained");

    act(() => setSplit(EPIC_A, DRAFT_A, "left"));
    act(() => setSplit(DRAFT_A, EPIC_A, "right"));

    const bodyAfter = screen.getByTestId("epic-surface-body-epic-a");
    expect(bodyAfter).toBe(bodyBefore);
    expect(bodyAfter.dataset.localValue).toBe("retained");
  });

  it("pins both active split members and evicts hidden surfaces by global MRU", async () => {
    const refs = Array.from({ length: 6 }, (_value, index) => ({
      kind: "epic" as const,
      id: `epic-${index}`,
    }));
    seedSources(refs);
    setSingle(refs[0], refs);
    render(<TopLevelTabHost />);

    for (const ref of refs.slice(1)) {
      act(() => setSingle(ref, refs));
    }

    await waitFor(() => {
      expect(screen.getAllByTestId(/^top-level-surface-epic-/)).toHaveLength(
        MAX_RETAINED_TOP_LEVEL_SURFACES,
      );
    });
    expect(screen.queryByTestId("top-level-surface-epic-0")).toBeNull();

    act(() => setSplitAlongside(refs[4], refs[5], "right", refs));

    await waitFor(() => {
      expect(surfaceRef(refs[4]).dataset.visible).toBe("true");
      expect(surfaceRef(refs[5]).dataset.visible).toBe("true");
      expect(screen.getAllByTestId(/^top-level-surface-epic-/)).toHaveLength(
        MAX_RETAINED_TOP_LEVEL_SURFACES,
      );
    });
  });

  it("evicts and reconstructs mixed-kind bodies while keeping an empty chooser side free", async () => {
    const refs = [EPIC_A, DRAFT_A, HISTORY, SETTINGS, EPIC_B, DRAFT_B];
    seedSources(refs);
    setSingle(EPIC_A, refs);
    render(<TopLevelTabHost />);

    const evictedBody = await screen.findByTestId("epic-surface-body-epic-a");
    refs.slice(1).forEach((ref) => {
      act(() => setSingle(ref, refs));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("epic-surface-body-epic-a")).toBeNull();
    });

    act(() => setSingle(EPIC_A, refs));

    await waitFor(() => {
      expect(screen.getByTestId("epic-surface-body-epic-a")).not.toBe(
        evictedBody,
      );
    });

    act(() => {
      useTabsStore.setState((state) => ({
        ...state,
        items: [
          {
            kind: "split",
            id: "chooser",
            left: { kind: "tab", ref: EPIC_A },
            right: { kind: "empty" },
            focusedSide: "right",
            routeBackingSide: "left",
            leftRatio: 0.5,
          },
          ...refs
            .filter((ref) => ref !== EPIC_A)
            .map((ref) => ({
              kind: "tab" as const,
              id: `tab:${ref.kind}:${ref.id}`,
              ref,
            })),
        ],
        activeItemId: "chooser",
        stripOrder: refs,
      }));
    });

    expect(screen.getByTestId("top-level-fillable-slot-right")).not.toBeNull();
    expect(screen.getAllByTestId(/^top-level-surface-/)).toHaveLength(5);
  });

  it("mounts exactly one landing terminal panel for a draft/draft split", () => {
    seedSources([DRAFT_A, DRAFT_B]);
    setSplit(DRAFT_A, DRAFT_B, "right");

    render(<LandingTerminalHost />);

    expect(screen.getAllByTestId("landing-terminal")).toHaveLength(1);
    expect(screen.getByTestId("landing-terminal").dataset.draftId).toBe(
      DRAFT_B.id,
    );
  });
});
