/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { domAnimation, LazyMotion } from "motion/react";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  ChatLowerDock,
  type DockRowHotspot,
} from "@/components/chat/chat-lower-dock";
import {
  ChatDockCompactStripProvider,
  type ChatDockCompactChipModel,
} from "@/components/chat/chat-dock-compact-strip";
import type { ChatDockSection } from "@/lib/chat/chat-dock-sections";
import {
  useChatDockOpenSection,
  useChatDockOpenStore,
} from "@/stores/chats/chat-dock-open-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";

/**
 * L-142: the compact pills are a ONE-AT-A-TIME switcher.
 *
 * Everything here is driven through the real wiring rather than a prop: the
 * open section comes from `chat-dock-open-store` (which is where the tile
 * reads it) and the click goes through the same `toggleSection` the strip
 * calls, so "clicking replaces" is observed as the dock's DOM rather than as a
 * callback argument.
 */

vi.mock("@/components/chat/agent-stop-button", () => ({
  AgentStopButton: (props: { readonly label: string }) => (
    <button type="button">{props.label}</button>
  ),
}));

vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandConfigureIsPending: () => false,
    useManagedCommandRelaunchOnHostRestart: (
      _target: unknown,
      streamed: { relaunchOnHostRestart: boolean },
    ) => streamed.relaunchOnHostRestart,
    useManagedCommandConfigure: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
    useManagedCommandDeliverHeld: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeldIsPending: () => false,
  }),
);

const CHAT_ID = "chat-1";
const OTHER_CHAT_ID = "chat-2";

/** Files changed and Background are pills; Active agents stays a full row. */
const PILL_SECTIONS: ReadonlyArray<ChatDockSection> = [
  "filesChanged",
  "background",
];

const DOCK_ORDER: ReadonlyArray<ChatDockSection> = [
  "filesChanged",
  "activeAgents",
  "background",
  "todo",
];

const BACKGROUND_ITEMS: ReadonlyArray<BackgroundItem> = [
  {
    taskId: "task-1",
    kind: "command",
    title: "bun test",
    blockId: "task-1-block",
    parentTaskId: null,
    scheduledFor: null,
    individualStopUnavailable: null,
  },
];

const FILE_CHANGE: AccumulatedChangeRow = {
  filePath: "/repo/src/app.ts",
  operation: "edit",
  diffSource: "snapshot",
  reason: "snapshot",
  undoable: true,
  artifact: null,
  counts: { additions: 3, deletions: 1 },
  hasContents: true,
  digest: null,
  liveDiff: null,
};

const RESTORE: ChatRestoreContextValue = {
  accessRole: "owner",
  currentUserId: "owner-1",
  activeHostId: "host-1",
  activeTurnStatus: null,
  localSnapshotsClearedAt: null,
  restore: null,
  restoreActionPending: false,
  restoreCheckpoint: () => null,
  accumulatedFileChanges: [FILE_CHANGE],
  undeliveredChangeCount: 0,
  accumulatedSetComplete: true,
  revertFileChanges: () => null,
};

const EMPTY_QUEUE: ChatSessionState["queue"] = { status: "idle", items: [] };

function hotspot(hasContent: boolean): DockRowHotspot {
  return {
    hotspotRef: () => undefined,
    shown: true,
    hasContent,
    ghost: false,
    editing: false,
  };
}

function chip(section: ChatDockSection): ChatDockCompactChipModel {
  return {
    section,
    glyph: section,
    hotspotRef: null,
    working: false,
    text: "1",
    lineDeltas: null,
    label: `${section} pill`,
    detail: `${section} detail`,
    pulseToken: null,
  };
}

/** The tile's own wiring in miniature: store in, `toggleSection` out. */
function DockHarness(props: { readonly chatId: string }) {
  const openSection = useChatDockOpenSection(props.chatId);
  const toggleSection = useChatDockOpenStore((state) => state.toggleSection);
  return (
    <TabHostProvider hostId="host-1">
      <TooltipProvider delay={0}>
        <ChatDockCompactStripProvider
          value={{
            chips: PILL_SECTIONS.map(chip),
            openSection,
            panelId: "dock-panel-1",
            onToggle: (section) => {
              toggleSection(props.chatId, section);
            },
          }}
        >
          <ChatLowerDock
            snapshotLoaded
            epicId="epic-1"
            chatId={props.chatId}
            viewTabId="tab-1"
            selfAgent={{
              id: "chat-1",
              title: "This chat",
              surface: "gui",
              activity: "turn",
              hostId: "host-1",
            }}
            activeAgents={[
              {
                id: "child-1",
                title: "Child one",
                surface: "gui",
                activity: "turn",
                hostId: "host-1",
              },
            ]}
            todo={null}
            restore={RESTORE}
            queue={EMPTY_QUEUE}
            folded={new Set(PILL_SECTIONS)}
            dockOrder={DOCK_ORDER}
            hotspots={{
              filesChanged: hotspot(true),
              activeAgents: hotspot(true),
              background: hotspot(true),
              todo: hotspot(false),
            }}
            backgroundItems={BACKGROUND_ITEMS}
            runningManagedCommandCount={0}
            portForwardCount={0}
            heldManagedCommandCount={0}
            backgroundStopPendingTaskIds={new Set()}
            backgroundStopAllPending={false}
            backgroundSessionStopPending={false}
            activeTurnStatus="running"
            canAct
            queueResumeRequested={false}
            queueKeepPausedRequested={false}
            readOnly={false}
            editingQueueItemId={null}
            topSpacing="normal"
            scrollRegionMaxHeightClass="max-h-96"
            onQueuePause={() => null}
            onQueueResume={() => null}
            onQueueEdit={() => undefined}
            onQueueCancel={() => undefined}
            onQueueAbortSteer={() => undefined}
            onQueueReorder={() => undefined}
            onQueueSteerNow={() => undefined}
            onBackgroundItemClick={() => undefined}
            onBackgroundItemStop={() => null}
            onBackgroundItemsStopAll={() => null}
            onBackgroundSessionStop={() => null}
          />
        </ChatDockCompactStripProvider>
      </TooltipProvider>
    </TabHostProvider>
  );
}

function attachedSections(): ReadonlyArray<string | null> {
  return [
    ...document.querySelectorAll("[data-testid='chat-dock-attached-panel']"),
  ].map((node) => node.getAttribute("data-dock-section"));
}

function clickPill(section: ChatDockSection): void {
  fireEvent.click(screen.getByTestId(`chat-dock-chip-${section}`));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restorePanelResizeObserver();
  useChatDockOpenStore.setState({ openByChatId: new Map() });
  useSettingsStore.setState({ chatDockPanelHeight: 0.33 });
  useThemeLibraryStore.setState({ panelAnimations: true });
});

/**
 * The dock with motion actually loaded.
 *
 * `m.*` components render as plain elements until a `LazyMotion` supplies the
 * features, which is why every other test in this file sees an instant
 * remove: that is the honest default for a suite about wiring. The three
 * below are about the motion itself, so they pay for it.
 */
function renderAnimatedDock(chatId: string) {
  return render(
    <LazyMotion features={domAnimation}>
      <DockHarness chatId={chatId} />
    </LazyMotion>,
  );
}

/**
 * The one panel body a reader would see as THE panel.
 *
 * A crossfade ghost answers to `chat-dock-attached-panel-leaving`, so this is
 * a plain query rather than a filter - which is the point of the rename: the
 * older call sites in this file and in three other suites ask for the bare id
 * and must never be handed two matches.
 */
function livePanelSections(): ReadonlyArray<string | null> {
  return [
    ...document.querySelectorAll("[data-testid='chat-dock-attached-panel']"),
  ].map((node) => node.getAttribute("data-dock-section"));
}

function leavingPanelSections(): ReadonlyArray<string | null> {
  return [
    ...document.querySelectorAll(
      "[data-testid='chat-dock-attached-panel-leaving']",
    ),
  ].map((node) => node.getAttribute("data-dock-section"));
}

/** The slot's two motion decisions, as it draws them. */
function slotMotion(): {
  readonly height: string | null;
  readonly exit: string | null;
} {
  const slot = screen.getByTestId("chat-dock-attached-panel-slot");
  return {
    height: slot.getAttribute("data-panel-motion"),
    exit: slot.getAttribute("data-panel-exit"),
  };
}

/**
 * A body that is showing less than it holds, which is the only state in which
 * the resize handle is offered (L-164).
 *
 * jsdom answers 0 to every layout question, so without this the panel is
 * never scrolling and the handle is never drawn - which is the honest
 * rendering of a jsdom panel (the handle's own suite is
 * `chat-dock-panel-pane-height.test.tsx`).
 */
function stubPanelScrolling(): void {
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
    function (this: Element) {
      return this.hasAttribute("data-dock-panel-body") ? 500 : 0;
    },
  );
}

/**
 * A ResizeObserver whose callback this suite can fire, so a SECOND
 * measurement can be driven - the case L-165 turns on and the one jsdom's
 * no-op observer can never reach on its own.
 */
class ControllablePanelResizeObserver implements ResizeObserver {
  private static observers: ControllablePanelResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  private target: Element | null = null;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControllablePanelResizeObserver.observers.push(this);
  }

  static install(): void {
    ControllablePanelResizeObserver.observers = [];
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: ControllablePanelResizeObserver,
    });
  }

  /** Fire every live observer, as a real one would on a layout change. */
  static remeasure(): void {
    act(() => {
      for (const observer of ControllablePanelResizeObserver.observers) {
        if (observer.target !== null) observer.callback([], observer);
      }
    });
  }

  observe(target: Element): void {
    this.target = target;
  }

  unobserve(): void {
    this.target = null;
  }

  disconnect(): void {
    this.target = null;
  }
}

/**
 * The global the setup file installs: a no-op, so a suite that has swapped in
 * the controllable one above cannot leak it into the next file.
 */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function restorePanelResizeObserver(): void {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: NoopResizeObserver,
  });
}

/**
 * The dock under a pane whose visibility this suite controls, which is the
 * input `useMotionEnabled` reads that is NOT a preference.
 */
function PaneVisibleDock(props: { readonly visible: boolean }) {
  return (
    <PaneVisibilityContext.Provider value={props.visible}>
      <LazyMotion features={domAnimation}>
        <DockHarness chatId={CHAT_ID} />
      </LazyMotion>
    </PaneVisibilityContext.Provider>
  );
}

/** The slot's single in-flow child, which is the box the observer reads. */
function panelBox(): Element {
  const box = screen.getByTestId(
    "chat-dock-attached-panel-slot",
  ).firstElementChild;
  if (box === null) throw new Error("the slot drew no box");
  return box;
}

/**
 * jsdom measures everything as zero, so the measured box states its height
 * and this suite moves it.
 */
function stubBoxHeight(node: Element, read: () => number): void {
  vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 600,
    bottom: read(),
    width: 600,
    height: read(),
    toJSON: () => ({}),
  }));
}

describe("compact pills are a one-at-a-time switcher", () => {
  it("attaches exactly one panel, and a second pill REPLACES it", () => {
    render(<DockHarness chatId={CHAT_ID} />);

    clickPill("filesChanged");
    expect(attachedSections()).toEqual(["filesChanged"]);

    clickPill("background");
    // One panel, and it is the other section's - a switch, never a stack.
    expect(attachedSections()).toEqual(["background"]);
    expect(
      screen.queryByRole("button", {
        name: "Undo changes to /repo/src/app.ts",
      }),
    ).toBeNull();
  });

  it("keeps focus on the pill across a swap", () => {
    render(<DockHarness chatId={CHAT_ID} />);

    const background = screen.getByTestId("chat-dock-chip-background");
    clickPill("filesChanged");
    background.focus();
    clickPill("background");

    expect(document.activeElement).toBe(background);
  });

  it("marks the open pill pressed and points it at the panel it controls", () => {
    stubPanelScrolling();
    render(<DockHarness chatId={CHAT_ID} />);

    clickPill("filesChanged");

    const pill = screen.getByTestId("chat-dock-chip-filesChanged");
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    expect(pill.getAttribute("aria-controls")).toBe("dock-panel-1");
    // The `aria-controls` target is the SLOT, not the body inside it: the
    // slot is the one box that survives a switch (L-152), so the id and the
    // region cannot live on a panel that is replaced under it.
    const slot = screen.getByTestId("chat-dock-attached-panel-slot");
    expect(slot.getAttribute("id")).toBe("dock-panel-1");
    expect(slot.getAttribute("role")).toBe("region");
    expect(slot.getAttribute("aria-label")).toBe("Files changed");
    // The handle names the same section it resizes.
    expect(
      screen
        .getByTestId("chat-dock-attached-panel-resize")
        .getAttribute("aria-label"),
    ).toBe("Resize the Files changed panel");
    // The pill that is NOT open points at nothing.
    expect(
      screen
        .getByTestId("chat-dock-chip-background")
        .getAttribute("aria-controls"),
    ).toBeNull();
  });

  it("puts the attached panel above the fixed full rows", () => {
    render(<DockHarness chatId={CHAT_ID} />);

    clickPill("background");

    const attached = screen.getByTestId("chat-dock-attached-panel");
    const fixedRow = screen.getByTestId("active-agents-panel");
    expect(attached.compareDocumentPosition(fixedRow)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("keeps the open panel's actions in the pill row, not in the panel", () => {
    render(<DockHarness chatId={CHAT_ID} />);

    clickPill("filesChanged");

    const actionsHost = screen.getByTestId("chat-dock-pill-actions");
    const undoAll = screen.getByTestId("accumulated-undo-all");
    expect(actionsHost.contains(undoAll)).toBe(true);
    expect(
      screen.getByTestId("chat-dock-attached-panel").contains(undoAll),
    ).toBe(false);
    // And the strip they live in is still the first cluster in the stack, so
    // the pills have not moved to make room for them.
    expect(
      screen
        .getByTestId("chat-dock-compact-strip")
        .contains(screen.getByTestId("chat-dock-chip-filesChanged")),
    ).toBe(true);
  });

  it("remembers the open pill per chat", () => {
    const view = render(<DockHarness chatId={CHAT_ID} />);
    clickPill("filesChanged");
    view.unmount();

    // A same-pane chat switch is a full remount; the panel comes back.
    render(<DockHarness chatId={CHAT_ID} />);
    expect(attachedSections()).toEqual(["filesChanged"]);

    cleanup();
    // Another conversation is another answer - and nothing auto-opens there.
    render(<DockHarness chatId={OTHER_CHAT_ID} />);
    expect(attachedSections()).toEqual([]);
  });
});

/**
 * L-152 and L-165: the panel grows out of the pill row on attach, collapses on
 * close, and crossfades its CONTENT while its height eases when a pill is
 * swapped - and nothing else about it eases.
 *
 * jsdom lays nothing out, so nothing here asserts a pixel. What it can decide,
 * and what the defects were made of, is WHICH elements are in the document
 * while a swap is playing, which of them the gate lets play at all, and which
 * height changes the slot chose to ease.
 */
describe("the attached panel's motion", () => {
  it("keeps the outgoing panel on screen, inert, while the incoming one is drawn", () => {
    renderAnimatedDock(CHAT_ID);

    clickPill("filesChanged");
    clickPill("background");

    // Both are in the document for the length of the crossfade: the old one
    // as a ghost out of flow, the new one in flow and alone in deciding the
    // height the slot eases to.
    expect(livePanelSections()).toEqual(["background"]);
    expect(leavingPanelSections()).toEqual(["filesChanged"]);
    // And the ghost is a ghost: a second copy of a dock panel lying over the
    // real one must not be clickable, tabbable or announced.
    const ghost = document.querySelector("[data-panel-leaving]");
    expect(ghost?.hasAttribute("inert")).toBe(true);
    // ONE slot throughout, which is what makes the height an ease rather than
    // a collapse and a regrow - and it never loses the id the pill points at.
    const slots = document.querySelectorAll(
      "[data-testid='chat-dock-attached-panel-slot']",
    );
    expect(slots.length).toBe(1);
    expect(slots[0]?.getAttribute("aria-label")).toBe("Background");
  });

  it("collapses the slot on close rather than dropping it", () => {
    renderAnimatedDock(CHAT_ID);

    clickPill("filesChanged");
    clickPill("filesChanged");

    // Still mounted, and marked as leaving: the box is easing its height back
    // to zero. `livePanelSections` is already empty, which is what every
    // other assertion in this file reads.
    const slot = screen.getByTestId("chat-dock-attached-panel-slot");
    expect(slot.getAttribute("data-panel-leaving")).toBe("true");
    expect(livePanelSections()).toEqual([]);
    // The collapsing copy keeps the SHAPE it had. Every panel reads the dock's
    // one context to decide whether it draws a collapsible header, so without
    // freezing that answer for a leaving copy it grows the header back half a
    // frame before it fades - a third state, mid-collapse.
    expect(leavingPanelSections()).toEqual(["filesChanged"]);
    expect(screen.queryByTestId("accumulated-changes-panel")).toBeNull();
    // Its actions go at once, though: they are PORTALLED into the pill row,
    // outside the ghost, where `inert` cannot reach them - so a frozen copy
    // would leave a live "Undo all" beside a pill the user has just closed.
    expect(screen.queryByTestId("accumulated-undo-all")).toBeNull();
  });

  // L-165, the whole of it: only attach, switch and close ease. A row arriving
  // mid-turn, an Arrow keypress on the handle and a pane resize all move the
  // same height through the same observer, and a 220ms tween restarted twelve
  // times in a turn is the frequency band L-148 already ruled out.
  it("eases the height it opens to, and lands every later measurement instantly", () => {
    ControllablePanelResizeObserver.install();
    stubPanelScrolling();
    renderAnimatedDock(CHAT_ID);
    clickPill("filesChanged");

    let boxHeight = 0;
    stubBoxHeight(panelBox(), () => boxHeight);

    boxHeight = 120;
    ControllablePanelResizeObserver.remeasure();
    expect(slotMotion().height).toBe("ease");

    // A second measurement for the SAME section: content arriving.
    boxHeight = 168;
    ControllablePanelResizeObserver.remeasure();
    expect(slotMotion().height).toBe("instant");

    // The keyboard step moves the cap, which moves the height, through the
    // same observer - and `motion-opportunities.md` R7 rejected easing it by
    // name.
    fireEvent.keyDown(screen.getByTestId("chat-dock-attached-panel-resize"), {
      key: "ArrowUp",
    });
    boxHeight = 196;
    ControllablePanelResizeObserver.remeasure();
    expect(slotMotion().height).toBe("instant");

    // A switch is one of the three, and it eases even though the measurement
    // that carries it arrives a commit after the click.
    clickPill("background");
    boxHeight = 240;
    ControllablePanelResizeObserver.remeasure();
    expect(slotMotion().height).toBe("ease");
  });

  it("swaps and closes without an exit to wait for when Panel animations are off", () => {
    useThemeLibraryStore.setState({ panelAnimations: false });
    renderAnimatedDock(CHAT_ID);

    clickPill("filesChanged");

    // The gate is on the exit VALUE, never on the presence root (see the pane
    // test below), so "off" has to be visible as the variant the slot chose.
    expect(slotMotion().exit).toBe("instant");

    clickPill("background");
    expect(livePanelSections()).toEqual(["background"]);
  });

  // R5D-02: `useMotionEnabled` includes pane visibility, and `TopLevelTabHost`
  // keeps inactive panes mounted under `display: none`. A presence root that
  // was mounted conditionally on that would reconcile a different element
  // every time the user switched tabs, destroying the open panel's scroll
  // position, its expanded rows and the queue's in-place edit with it.
  it("keeps the open panel's own element through a pane going invisible and back", () => {
    const view = render(<PaneVisibleDock visible />);
    clickPill("filesChanged");
    const opened = screen.getByTestId("chat-dock-attached-panel-slot");
    expect(slotMotion().exit).toBe("ease");

    view.rerender(<PaneVisibleDock visible={false} />);
    // Same node, not a look-alike: the panel was never unmounted.
    expect(screen.getByTestId("chat-dock-attached-panel-slot")).toBe(opened);
    // Only the value moved.
    expect(slotMotion().exit).toBe("instant");

    view.rerender(<PaneVisibleDock visible />);
    expect(screen.getByTestId("chat-dock-attached-panel-slot")).toBe(opened);
    expect(slotMotion().exit).toBe("ease");
  });
});

describe("the attached panel's motion contract", () => {
  const source = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "chat-dock-attached-panel.tsx",
    ),
    "utf8",
  );
  const stylesheet = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "index.css",
    ),
    "utf8",
  );

  it("stays inside the ruling's ceiling, on the app's own curve", () => {
    // Every duration this file hands motion is under the 250ms ceiling, so a
    // retune inside it passes and a slower one does not.
    const durations = [...source.matchAll(/\bduration: ([\d.]+)/g)].map(
      (match) => Number(match[1]),
    );
    expect(durations.length).toBeGreaterThan(0);
    for (const duration of durations) {
      expect(duration).toBeLessThan(0.25);
    }
    // Every cubic curve is the app's own spring, read off the stylesheet
    // rather than restated here.
    const spring = /--ease-spring: cubic-bezier\(([^)]*)\)/.exec(
      stylesheet,
    )?.[1];
    expect(spring).toBeDefined();
    const curves = [...source.matchAll(/\bease: \[([^\]]*)\]/g)].map(
      (match) => match[1],
    );
    expect(curves.length).toBeGreaterThan(0);
    for (const curve of curves) {
      expect(curve).toBe(spring);
    }
    // The swap's blur that bridges two legible lists.
    expect(source).toContain('filter: "blur(2px)"');
    expect(source).toContain('filter: "blur(0px)"');
  });

  it("animates nothing but height, opacity and filter", () => {
    // Read the VARIANTS rather than banning words. Every value this file ever
    // hands motion lives in a `PANEL_*` constant, so the union of their keys
    // is the whole set of properties the panel can animate, and a `scale` or
    // an `x` added to any of them lands here. `height` is the one
    // non-compositor property and it is confined to the slot; anything
    // reaching for a transform would be moving the composer, which is the
    // thing L-152 forbids.
    const variants = [
      ...source.matchAll(
        /^const PANEL_[A-Z_]+ = \{([\s\S]*?)\}\s*(?:as const|satisfies)/gm,
      ),
    ];
    expect(variants.length).toBeGreaterThan(6);
    const keys = new Set(
      variants.flatMap((variant) =>
        [...variant[1].matchAll(/\b([A-Za-z]+):/g)].map((key) => key[1]),
      ),
    );
    expect([...keys].sort()).toEqual([
      "duration",
      "ease",
      "filter",
      "height",
      "opacity",
      "transition",
    ]);
  });

  it("never animates layout, and never paints a remembered pill in", () => {
    // Matched as a PROP on its own line, not inside a `<m.x ...>` fence: the
    // fence's `[^>]*` stops at the first `>`, and the slot's opening tag has
    // one inside `animate={height > 0 ? ... }` - so the one element whose
    // layout animation would move the composer was the one the guard could
    // not see. Prettier puts every prop of a multi-prop tag on its own line,
    // so this is where an author's `layout` lands; the second form catches a
    // single-prop tag written inline.
    expect(source).not.toMatch(
      /^\s*layout(?:Id|Root|Dependency)?\b\s*(?:=|$)/m,
    );
    expect(source).not.toMatch(/<m\.[a-z]+\s+layout(?:Id|Root|Dependency)?\b/);
    // Both presence roots: the slot's is in `chat-lower-dock.tsx`, this file
    // owns the content swap's.
    expect(/<AnimatePresence[^>]*>/.exec(source)?.[0] ?? "").toContain(
      "initial={false}",
    );
  });
});
