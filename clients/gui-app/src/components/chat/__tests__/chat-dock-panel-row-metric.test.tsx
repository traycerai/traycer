import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatPortForward } from "@traycer/protocol/host/port-forward";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { AgentStopList } from "@/components/chat/chat-agent-stop-list";
import {
  disposeManagedCommandChatSessions,
  installManagedCommandChatSession,
  type ManagedCommandChatSessionStub,
} from "@/stores/managed-commands/test-support/managed-command-chat-session";
import {
  ChatLowerDock,
  type DockRowHotspot,
} from "@/components/chat/chat-lower-dock";
import {
  CHAT_DOCK_PANEL_LIST,
  CHAT_DOCK_PANEL_ROW,
  CHAT_DOCK_PANEL_ROW_TEXT,
} from "@/components/chat/chat-dock-panel-row";
import {
  ChatDockCompactStripProvider,
  type ChatDockCompactChipModel,
} from "@/components/chat/chat-dock-compact-strip";
import type { ChatDockSection } from "@/lib/chat/chat-dock-sections";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

// A port-forward row's Stop is wired through a real `useMutation`, which needs
// a client above it even though nothing here dispatches one.
const queryClient = new QueryClient({
  defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
});

/**
 * L-171: the five attached dock panels share ONE row metric.
 *
 * The pills are a one-at-a-time switcher, so a panel showing one one-line row
 * has to measure the same whichever member it belongs to - otherwise every
 * switch between two one-line panels moves the composer's upper edge, which is
 * what the owner saw going from one changed file to one background shell.
 *
 * What is asserted here is the RECIPE, read off `chat-dock-panel-row.ts`
 * rather than spelled out as class strings: jsdom resolves no `min-h-8` into a
 * number, so the height itself is the real-Chrome test's claim
 * (`browser-tests/layout-editor/parity.spec.ts`, "the attached dock panels
 * share one row metric to the pixel"). This file is what keeps a panel from
 * quietly leaving the recipe between browser runs - a sixth member, or a row
 * rewritten with its own padding.
 */

/**
 * The four boundaries these rows reach past the DOM, and nothing else.
 *
 * Three of the row shapes this file now renders resolve a host client, a host
 * directory, a link opener or the open epic, and every one of those throws
 * without the app around it. None of them decides a class, so each is answered
 * with the smallest thing that lets the row draw: what is under test is the
 * markup, and the real controls are mounted in the driver.
 */
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({
    request: vi.fn(),
    getActiveHostId: () => "host-1",
  }),
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useOpenEpicId: () => "epic-1",
  // No artifact is projected here, so the row falls back to the tag's own
  // title and draws its non-openable branch - which is the branch both gates
  // were missing, and which carries the same two tokens as the openable one.
  useArtifactById: () => null,
}));

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

const DOCK_ORDER: ReadonlyArray<ChatDockSection> = [
  "filesChanged",
  "activeAgents",
  "background",
  "todo",
];

/** One one-line row per member, which is the case the ruling binds. */
const ONE_BACKGROUND_ITEM: ReadonlyArray<BackgroundItem> = [
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

const ONE_FILE_CHANGE: AccumulatedChangeRow = {
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

/**
 * The other branch of the same row (R6H-03).
 *
 * `AccumulatedChangeRow` draws `ArtifactAccumulatedHeader` instead of
 * `FileChangeHeader` when `artifact` is set, and that branch used a third text
 * size while the constants file claimed it did not. Neither gate rendered it,
 * because every fixture in the tree pins `artifact: null`.
 */
const ONE_ARTIFACT_CHANGE: AccumulatedChangeRow = {
  filePath: "artifact:spec-1",
  operation: "edit",
  diffSource: "snapshot",
  reason: "snapshot",
  undoable: true,
  artifact: { artifactId: "spec-1", kind: "spec", title: "The plan" },
  counts: { additions: 2, deletions: 0 },
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
  accumulatedFileChanges: [ONE_FILE_CHANGE, ONE_ARTIFACT_CHANGE],
  undeliveredChangeCount: 0,
  accumulatedSetComplete: true,
  revertFileChanges: () => null,
};

const ONE_TODO: PinnedTodoSnapshot = {
  id: "todo-1",
  items: [
    {
      id: "todo-item-1",
      status: "in_progress",
      text: "Give the titles more room",
      priority: null,
      activeForm: "Giving the titles more room",
    },
  ],
};

/**
 * The message a queued row carries, whoever sent it.
 *
 * Two rows, not one: the second is the same prompt sent by an AGENT, which is
 * the row that draws a provenance badge. L-172 makes that badge a chip the
 * message wraps around rather than a line above it, so the two rows have to
 * carry the same recipe and the panel has to stay a two-row panel.
 */
const QUEUED_DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Then check the order." }],
    },
  ],
};

const ONE_QUEUED_MESSAGE: ChatSessionState["queue"] = {
  status: "running",
  items: [
    {
      kind: "prompt",
      sentFromHostId: null,
      queueItemId: "queue-1",
      messageId: "queue-1-message",
      message: {
        kind: "user",
        content: QUEUED_DOC,
        browserAnnotations: [],
      },
      sender: { type: "user", userId: "user-1" },
      settings: {
        harnessId: "claude",
        model: "model",
        permissionMode: "supervised",
        reasoningEffort: "medium",
        serviceTier: null,
        agentMode: "epic",
        profileId: null,
      },
      accountContext: { type: "PERSONAL" },
      delivery: "next_turn",
      status: "pending",
      targetTurnId: null,
      steerRequest: null,
      fallbackReason: null,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      kind: "prompt",
      sentFromHostId: null,
      queueItemId: "queue-2",
      messageId: "queue-2-message",
      message: {
        kind: "user",
        content: QUEUED_DOC,
        browserAnnotations: [],
      },
      sender: {
        type: "agent",
        harnessId: "claude",
        agentId: "agent-1",
        displayName: "Sample reviewer",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      settings: {
        harnessId: "claude",
        model: "model",
        permissionMode: "supervised",
        reasoningEffort: "medium",
        serviceTier: null,
        agentMode: "epic",
        profileId: null,
      },
      accountContext: { type: "PERSONAL" },
      delivery: "next_turn",
      status: "pending",
      targetTurnId: null,
      steerRequest: null,
      fallbackReason: null,
      createdAt: 2,
      updatedAt: 2,
    },
  ],
};

/**
 * The Background panel's other three row shapes (R6H-10).
 *
 * `HeldManagedCommandRow`, `ManagedCommandRow` and `PortForwardRow` are all
 * changed by this ticket and none of them is reachable through
 * `ChatLowerDock`'s props: they come from the chat-session store, which is why
 * they had no coverage here at all. The panel with the most row shapes is the
 * one that needs more than one of them in the fixture.
 */
const RUNNING_COMMAND: ManagedCommand = {
  id: "cmd-running",
  monitoring: true,
  description: "deploy watcher",
  command: "tail -f deploy.log",
  cwd: "/work/repo",
  cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
  status: { state: "running", pid: 4410, startedAtMs: 10 },
  chatId: "chat-1",
  relaunchOnHostRestart: false,
  createdAtMs: 10,
  updatedAtMs: 10,
};

const ONE_PORT_FORWARD: ChatPortForward = {
  forwardId: "forward-1",
  description: "dev server",
  target: { hostId: "host-target", port: 3000 },
  listen: { hostId: "host-listen", requestedPort: 8080, boundPort: null },
  state: "active",
  stateReason: null,
  createdAtMs: 1,
  recentEvents: [],
};

function installBackgroundRowShapes(): ManagedCommandChatSessionStub {
  const session = installManagedCommandChatSession({
    epicId: "epic-1",
    chatId: "chat-1",
    hostId: "host-1",
  });
  session.setCommands([RUNNING_COMMAND]);
  session.setHeldUpdates([
    { commandId: "cmd-held", description: "held digest", heldAtMs: 10 },
  ]);
  session.setPortForwards([ONE_PORT_FORWARD]);
  return session;
}

function hotspot(): DockRowHotspot {
  return {
    hotspotRef: () => undefined,
    shown: true,
    hasContent: true,
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

function renderAttached(section: ChatDockSection) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId="host-1">
        <TooltipProvider delayDuration={0}>
          <ChatDockCompactStripProvider
            value={{
              chips: DOCK_ORDER.map(chip),
              openSection: section,
              panelId: "dock-panel-1",
              onToggle: () => undefined,
            }}
          >
            <ChatLowerDock
              snapshotLoaded
              epicId="epic-1"
              chatId="chat-1"
              viewTabId="tab-1"
              selfAgent={{
                id: "chat-1",
                title: "This chat",
                surface: "gui",
                activity: "turn",
                hostId: "host-1",
              }}
              activeAgents={[]}
              todo={ONE_TODO}
              restore={RESTORE}
              queue={ONE_QUEUED_MESSAGE}
              folded={new Set(DOCK_ORDER)}
              dockOrder={DOCK_ORDER}
              hotspots={{
                filesChanged: hotspot(),
                activeAgents: hotspot(),
                background: hotspot(),
                todo: hotspot(),
              }}
              backgroundItems={ONE_BACKGROUND_ITEM}
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
    </QueryClientProvider>,
  );
}

// `classList`, not `className`: an SVG's is an `SVGAnimatedString`, and the
// row scan below walks every element in the panel, glyphs included.
function classesOf(node: Element): ReadonlySet<string> {
  return new Set(node.classList);
}

function missingFrom(node: Element, recipe: string): ReadonlyArray<string> {
  const present = classesOf(node);
  return recipe.split(" ").filter((token) => !present.has(token));
}

/** The body the attached slot sizes itself to, for the open section. */
function attachedBody(): Element {
  const panel = document.querySelector(
    "[data-testid='chat-dock-attached-panel']",
  );
  if (panel === null) throw new Error("no attached panel");
  const body = panel.firstElementChild;
  if (body === null) throw new Error("the attached panel drew no body");
  return body;
}

/**
 * Every element in the panel that claims the shared row box.
 *
 * Found by the recipe rather than by a tag or a test id, because the five rows
 * disagree on both: an `li` here, an indented `div` inside one there, a
 * sortable `div` in the queue.
 */
function rowsIn(body: Element): ReadonlyArray<Element> {
  return [...body.querySelectorAll("*")].filter(
    (node) => missingFrom(node, CHAT_DOCK_PANEL_ROW).length === 0,
  );
}

/**
 * Every row SHAPE each panel can draw, not one specimen each.
 *
 * Three of the Background panel's four and the changed-files panel's artifact
 * branch were changed by this ticket and rendered by neither gate, so a later
 * edit could have reinstated a `py-1` on any of them and stayed green
 * (R6H-03, R6H-10). The queue is no longer one of these attached members
 * (G1-G2: it is a fixed slot, never a pill) - its two row shapes are pinned
 * separately below.
 */
const ROWS_PER_SECTION: Readonly<Record<ChatDockSection, number>> = {
  filesChanged: 2,
  activeAgents: 1,
  background: 4,
  todo: 1,
};

let backgroundSession: ManagedCommandChatSessionStub | null = null;

afterEach(() => {
  cleanup();
  backgroundSession?.dispose();
  backgroundSession = null;
  disposeManagedCommandChatSessions();
  vi.restoreAllMocks();
});

describe("the five attached dock panels share one row metric", () => {
  for (const section of DOCK_ORDER) {
    it(`draws ${section}'s list and row from the shared recipe`, () => {
      backgroundSession = installBackgroundRowShapes();
      renderAttached(section);
      const body = attachedBody();

      const list = body.firstElementChild;
      expect(list).not.toBeNull();
      if (list === null) return;
      expect(missingFrom(list, CHAT_DOCK_PANEL_LIST)).toEqual([]);

      // Every shape the panel was fed, and no more: an extra match would mean
      // a nested box wearing the row's class, which would double the inset
      // the ruling pins.
      expect(rowsIn(body)).toHaveLength(ROWS_PER_SECTION[section]);
    });
  }

  /**
   * One text size across the five (L-171) - the half of the ruling a box
   * metric alone does not carry.
   *
   * The defect had two shapes. Todo's rows named no size at all and inherited
   * the app's `text-ui` (15px on a 22.5px line box) while the panel beside
   * them drew 11.25px; the queue's message text was `text-ui-sm`. Both are
   * the "difference in text sizes" the owner named, and an ABSENT token is
   * why this is spelled as the exact set each panel puts on screen rather
   * than as "nothing else": a missing size is invisible to a ban list.
   *
   * Changed files is the one exception and is pinned here rather than waved
   * at: its path and its `+/-` are CODE, they are the same component the
   * transcript and the diff tile draw, and both sit inside the row's height
   * budget. Moving them is a decision, so it has to be made here too.
   */
  const ROW_TEXT_SIZES: Readonly<
    Record<ChatDockSection, ReadonlyArray<string>>
  > = {
    // The file branch's verb and path plus the artifact branch's title on
    // the code ramp, the artifact verb and the port-forward-style chips on
    // the shared token, the `+/-` deltas one step down.
    filesChanged: ["text-code-sm", "text-code-xs", CHAT_DOCK_PANEL_ROW_TEXT],
    activeAgents: [CHAT_DOCK_PANEL_ROW_TEXT],
    background: [CHAT_DOCK_PANEL_ROW_TEXT],
    todo: [CHAT_DOCK_PANEL_ROW_TEXT],
  };

  for (const section of DOCK_ORDER) {
    it(`sizes ${section}'s row text from the shared token`, () => {
      backgroundSession = installBackgroundRowShapes();
      renderAttached(section);
      const body = attachedBody();
      const sizes = new Set<string>();
      for (const node of body.querySelectorAll("*")) {
        // A Button's own type scale belongs to the design system:
        // `buttonVariants` puts `text-ui-sm` on its base and every size that
        // carries a label overrides it. What the ruling is about is the row's
        // LABEL, which each panel draws in an element of its own.
        if (node.tagName === "BUTTON") continue;
        // Nor is a chip that declares its own line box: `leading-none` with a
        // fixed height is a design-system glyph (the spinner, a `Badge`),
        // which cannot move a line of row text or a row's height.
        if (classesOf(node).has("leading-none")) continue;
        for (const token of classesOf(node)) {
          if (token.startsWith("text-ui") || token.startsWith("text-code"))
            sizes.add(token);
        }
      }
      expect([...sizes].sort()).toEqual([...ROW_TEXT_SIZES[section]].sort());
    });
  }

  /**
   * The same list on its OTHER surface (R6H-06).
   *
   * `AgentStopList` is one list drawn twice - the Active agents panel and the
   * TUI agent tile's popover - and it took this metric unconditionally, which
   * grew the popover's rows from 26.25px to 30px. That is the right answer,
   * one metric for one list, but it was an answer nobody had written down and
   * nothing measured. This is the pin: the popover renders the same recipe, so
   * a later "the dock needs its own" cannot quietly fork them.
   */
  it("draws the TUI agent popover's rows from the same recipe", () => {
    render(
      <TabHostProvider hostId="host-1">
        <TooltipProvider delayDuration={0}>
          <AgentStopList
            epicId="epic-1"
            viewTabId="tab-1"
            self={{
              id: "chat-1",
              title: "This chat",
              surface: "tui",
              activity: "turn",
              hostId: "host-1",
            }}
            descendants={[]}
            surface="tui-popover"
          />
        </TooltipProvider>
      </TabHostProvider>,
    );
    const list = document.querySelector("ul");
    if (list === null) throw new Error("the popover drew no list");
    expect(missingFrom(list, CHAT_DOCK_PANEL_LIST)).toEqual([]);
    const rows = [...list.children].filter(
      (node) => missingFrom(node, CHAT_DOCK_PANEL_ROW).length === 0,
    );
    expect(rows).toHaveLength(1);
  });

  /**
   * What the queue gave up when it took the shared box, and what replaced it.
   *
   * Its rows are the only PROSE in the dock, so they need a row boundary most:
   * two wrapped messages are four 15px lines with the list's 1.875px gap
   * somewhere in the middle, and without a boundary the block reads as one
   * paragraph (R6H-01). `divide-y` genuinely had to go, because a 1px rule per
   * boundary breaks the N-row formula, so the hairline comes back as a
   * pseudo-element in the gap and the row takes the siblings' hover fill.
   *
   * `self-start` is the same story one level down: the row went from
   * `items-start` to the recipe's `items-center`, which on a three-line
   * message left the grip pointing at the middle of a paragraph while the
   * toolbar it pairs with stayed pinned at the top (R6H-02).
   *
   * And the toolbar keeps its own spacing, paid for out of the row's padding
   * rather than by shrinking: `gap-1` puts two `size-6` centres 26.25px apart
   * instead of 24.375px, and `-my-0.5` cancels `p-0.5` so the float's margin
   * box stays at 24.5px inside the 26.25px budget (R6H-05).
   */
  it("keeps the queue's row boundary, grip and toolbar spacing", () => {
    // The queue is a fixed slot now (G1-G2), not one of the attached members,
    // so it renders alongside whichever pill is open - "todo" here, chosen
    // arbitrarily.
    renderAttached("todo");
    const rows = [
      ...document.querySelectorAll("[data-testid='queued-message-row']"),
    ];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const classes = classesOf(row);
      expect(classes.has("hover:bg-muted/40")).toBe(true);
      // Out of flow, so N rows still measure what N rows measure.
      expect(classes.has("before:absolute")).toBe(true);
      expect(classes.has("before:h-px")).toBe(true);
      expect(classes.has("first:before:hidden")).toBe(true);
    }

    for (const handle of document.querySelectorAll(
      "[data-testid='queued-message-drag-handle']",
    )) {
      expect(classesOf(handle).has("self-start")).toBe(true);
    }

    const toolbar = document.querySelector(
      "[data-testid='queued-message-row-toolbar']",
    );
    if (toolbar === null) throw new Error("the owned row drew no toolbar");
    const toolbarClasses = classesOf(toolbar);
    expect(toolbarClasses.has("gap-1")).toBe(true);
    expect(toolbarClasses.has("p-0.5")).toBe(true);
    expect(toolbarClasses.has("-my-0.5")).toBe(true);
  });

  /**
   * The port-forward row's twisty belongs to the glyph it opens (R6H-08).
   *
   * The shared content class carries `gap-2`, which the row had never had, so
   * adopting it put the same 7.5px between the chevron and the `Cable` as
   * between the `Cable` and the label - and the chevron read as a sibling of
   * the label rather than as the row's own disclosure.
   */
  it("clusters the port-forward row's twisty with its kind glyph", () => {
    backgroundSession = installBackgroundRowShapes();
    renderAttached("background");
    const trigger = document.querySelector(
      "[data-testid='port-forward-row-forward-1']",
    );
    if (trigger === null) throw new Error("no port-forward row");
    const cluster = trigger.firstElementChild;
    if (cluster === null) throw new Error("the row drew no leading cluster");
    expect(classesOf(cluster).has("gap-1")).toBe(true);
    expect(cluster.childElementCount).toBe(2);
  });

  /**
   * L-172: a queued message's provenance badge is a chip the text wraps
   * around, not a line above it.
   *
   * jsdom lays nothing out, so the claim it can decide is the SHAPE that
   * makes the height claim true: the badge is a float inside the same scroll
   * box the message renders in, rather than a sibling block before it. The
   * height itself is the driver's, which measures this panel against the
   * other five.
   */
  it("floats a queued row's provenance badge inside the message box", () => {
    renderAttached("todo");
    const chip = document.querySelector(
      "[data-testid='queued-message-provenance-chip']",
    );
    if (chip === null) throw new Error("the agent-sent row drew no chip");
    expect(classesOf(chip).has("float-left")).toBe(true);
    const scroll = chip.closest(
      "[data-testid='queued-message-content-scroll']",
    );
    expect(scroll).not.toBeNull();
  });
});
