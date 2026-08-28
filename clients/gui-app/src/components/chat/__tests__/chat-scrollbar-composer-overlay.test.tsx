/**
 * Regression coverage for the chat scrollbar / lower-composer overlay fix:
 *
 * 1. Full-width absolute lower chrome stays pointer- and paint-transparent so
 *    the transcript scrollbar edge lanes stay visible and reachable.
 * 2. Outer px-4 wrappers carry no bg-canvas and no vertical pt/pb; centered
 *    max-w-3xl children own bg-canvas + vertical spacing + pointer restore.
 * 3. Main ChatComposer (always) and ComposerSlotShell (when bottomSpacing is
 *    "normal") paint a 1px pointer-free after: seal so scrolling transcript
 *    cannot peek a 1px seam under the backplate.
 * 4. ChatTimeline does not opt out of the app-wide compact scrollbar theme.
 *
 * Prefer render/DOM class assertions. ChatTile's absolute lower wrapper and
 * ChatComposer's rate-limit / main chrome depend on the full epic-session +
 * host/draft/provider stack, so those pins use source-shape assertions with
 * an explicit why. ComposerSlotShell's seal-off branch (bottomSpacing "none")
 * is also source-pinned: it only mounts for approval queues stacked above a
 * dock, which needs a heavier approvals fixture than this focused suite.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { ChatLowerDock } from "@/components/chat/chat-lower-dock";
import { ChatTimeline } from "@/components/chat/chat-timeline";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WORKSPACE_COMPOSER_READY } from "@/lib/composer/workspace-composer-availability";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { makeMessage } from "./chat-message-fixtures";
import { installLegendListViewportMetrics } from "./legend-list-test-environment";

vi.mock("@/components/chat/composer/chat-composer", () => ({
  ChatComposer: () => <div data-testid="composer-stub" />,
}));
vi.mock("@/components/chat/chat-stop-children-dialog", () => ({
  StopChildrenDialog: () => null,
}));
vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));
vi.mock("@/hooks/agent/use-stop-agent-mutation", () => ({
  useAgentStop: () => ({ mutate: () => undefined }),
}));
// The background panel reaches for the managed half's RPCs whether or not any
// managed command is on screen; this suite is about paint and pointer regions,
// so the host boundary behind them is faked away.
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
    useManagedCommandDeliverHeld: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeldIsPending: () => false,
  }),
);

import {
  ChatLowerInteractionSurfaces,
  type ChatLowerAccessState,
  type ChatLowerApprovalsState,
  type ChatLowerComposerState,
  type ChatLowerInteractionSurfacesProps,
  type ChatLowerInterviewState,
  type ChatLowerQueueState,
  type ChatLowerRuntimeState,
  type ChatLowerTurnState,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";

const GUI_APP_SRC = path.resolve(__dirname, "../../..");

/** Pseudo-element seal shared by ChatComposer and ComposerSlotShell. */
const BOTTOM_SEAL_CLASSES =
  "after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-canvas after:content-['']";

function sourceOf(relativeFromSrc: string): string {
  return readFileSync(path.join(GUI_APP_SRC, relativeFromSrc), "utf8");
}

function classTokens(className: string): ReadonlySet<string> {
  return new Set(className.split(/\s+/).filter(Boolean));
}

function hasAnyVerticalPadding(className: string): boolean {
  return /\b(pt|pb|py)-\S+/.test(className);
}

/**
 * Full-width outer chrome: pointer-none, horizontal px only, no paint, no
 * vertical padding. Centered max-w-3xl child restores pointer-auto + owns
 * bg-canvas (and typically vertical spacing).
 */
function expectEdgeLaneOuterWithCenteredPaint(
  outer: Element,
  options: {
    readonly centeredMustInclude: ReadonlyArray<string>;
    readonly centeredMustExclude?: ReadonlyArray<string>;
  },
): HTMLElement {
  const outerClass = (outer as HTMLElement).className;
  expect(outerClass).toContain("pointer-events-none");
  expect(outerClass).toContain("px-4");
  expect(classTokens(outerClass).has("pointer-events-auto")).toBe(false);
  expect(outerClass).not.toContain("bg-canvas");
  expect(hasAnyVerticalPadding(outerClass)).toBe(false);

  const centered = outer.querySelector(":scope > .max-w-3xl");
  expect(centered).not.toBeNull();
  const centeredClass = (centered as HTMLElement).className;
  expect(centeredClass).toContain("pointer-events-auto");
  expect(centeredClass).toContain("max-w-3xl");
  expect(centeredClass).toContain("mx-auto");
  expect(centeredClass).toContain("w-full");
  expect(centeredClass).toContain("bg-canvas");
  for (const token of options.centeredMustInclude) {
    expect(centeredClass).toContain(token);
  }
  for (const token of options.centeredMustExclude ?? []) {
    expect(centeredClass).not.toContain(token);
  }
  return centered as HTMLElement;
}

describe("chat scrollbar + lower composer overlay pointer isolation", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe("ChatTimeline (render)", () => {
    it("does not opt out via data-native-scrollbar and remains the sole vertical scroll owner", () => {
      installLegendListViewportMetrics();
      const listRef = createRef<LegendListRef | null>();
      render(
        <div style={{ height: 700, width: 800 }}>
          <ChatTimeline
            messages={[makeMessage(0, "user")]}
            taskTitle="Overlay regression transcript"
            backgroundToolBlockIds={new Set()}
            getMessageActions={() => null}
            nextStepActions={null}
            listRef={listRef}
            className="h-full"
            data-testid="chat-timeline-overlay"
          />
        </div>,
      );

      const listElement = screen.getByTestId("chat-timeline-overlay");
      expect(listElement.hasAttribute("data-native-scrollbar")).toBe(false);
      expect(listElement.getAttribute("data-native-scrollbar")).toBeNull();
      expect(listElement.className).toContain("overflow-y-auto");
      expect(listElement.className).toContain("overflow-x-hidden");
      expect(listElement.className).toContain("overscroll-y-contain");
      // showsVerticalScrollIndicator stays on; LegendList only adds this class
      // when the indicator is suppressed.
      expect(listElement.className).not.toContain(
        "legend-list-scrollbar-y-hidden",
      );
    });
  });

  describe("ChatLowerDock (render)", () => {
    it("keeps full-width chrome as edge-lane only; centered column owns paint and vertical spacing", () => {
      render(
        // The dock's background panel reads the tile's bound host to open a
        // managed command's output window, as it does inside a real tile.
        <TabHostProvider hostId="host-1">
          <TooltipProvider delayDuration={0}>
            <ChatLowerDock
              snapshotLoaded
              epicId="epic-1"
              chatId="chat-1"
              runningManagedCommandCount={0}
              heldManagedCommandCount={0}
              viewTabId="tab-1"
              selfAgent={null}
              activeAgents={[]}
              todo={null}
              restore={emptyRestore()}
              queue={emptyQueue()}
              queueResumeRequested={false}
              queueKeepPausedRequested={false}
              backgroundItems={[
                {
                  taskId: "task-1",
                  kind: "command",
                  title: "bun test",
                  blockId: "tool-1",
                  parentTaskId: null,
                  scheduledFor: null,
                  individualStopUnavailable: null,
                },
              ]}
              backgroundStopPendingTaskIds={new Set()}
              backgroundStopAllPending={false}
              backgroundSessionStopPending={false}
              activeTurnStatus="running"
              canAct
              readOnly={false}
              editingQueueItemId={null}
              topSpacing="normal"
              scrollRegionMaxHeightClass="max-h-96"
              onQueuePause={() => null}
              onQueueResume={() => null}
              onQueueEdit={vi.fn()}
              onQueueCancel={vi.fn()}
              onQueueAbortSteer={vi.fn()}
              onQueueReorder={vi.fn()}
              onQueueSteerNow={vi.fn()}
              onBackgroundItemClick={() => undefined}
              onBackgroundItemStop={() => null}
              onBackgroundItemsStopAll={() => null}
              onBackgroundSessionStop={() => null}
            />
          </TooltipProvider>
        </TabHostProvider>,
      );

      const dock = screen.getByTestId("chat-lower-dock");
      const centered = expectEdgeLaneOuterWithCenteredPaint(dock, {
        centeredMustInclude: ["pt-4"],
      });
      // Dock is not a bottom-of-pane backplate; it has no 1px after seal.
      expect(centered.className).not.toContain("after:h-px");
      expect(
        centered.contains(
          screen.getByRole("button", { name: /Background.*1 running/ }),
        ),
      ).toBe(true);
    });

    it("moves compact top spacing onto the centered column only", () => {
      render(
        // The dock's background panel reads the tile's bound host to open a
        // managed command's output window, as it does inside a real tile.
        <TabHostProvider hostId="host-1">
          <TooltipProvider delayDuration={0}>
            <ChatLowerDock
              snapshotLoaded
              epicId="epic-1"
              chatId="chat-1"
              runningManagedCommandCount={0}
              heldManagedCommandCount={0}
              viewTabId="tab-1"
              selfAgent={null}
              activeAgents={[]}
              todo={null}
              restore={emptyRestore()}
              queue={emptyQueue()}
              queueResumeRequested={false}
              queueKeepPausedRequested={false}
              backgroundItems={[
                {
                  taskId: "task-1",
                  kind: "command",
                  title: "bun test",
                  blockId: "tool-1",
                  parentTaskId: null,
                  scheduledFor: null,
                  individualStopUnavailable: null,
                },
              ]}
              backgroundStopPendingTaskIds={new Set()}
              backgroundStopAllPending={false}
              backgroundSessionStopPending={false}
              activeTurnStatus="running"
              canAct
              readOnly={false}
              editingQueueItemId={null}
              topSpacing="compact"
              scrollRegionMaxHeightClass="max-h-96"
              onQueuePause={() => null}
              onQueueResume={() => null}
              onQueueEdit={vi.fn()}
              onQueueCancel={vi.fn()}
              onQueueAbortSteer={vi.fn()}
              onQueueReorder={vi.fn()}
              onQueueSteerNow={vi.fn()}
              onBackgroundItemClick={() => undefined}
              onBackgroundItemStop={() => null}
              onBackgroundItemsStopAll={() => null}
              onBackgroundSessionStop={() => null}
            />
          </TooltipProvider>
        </TabHostProvider>,
      );

      const dock = screen.getByTestId("chat-lower-dock");
      expectEdgeLaneOuterWithCenteredPaint(dock, {
        centeredMustInclude: ["pt-2"],
        centeredMustExclude: ["pt-4"],
      });
    });
  });

  describe("ComposerSlotShell via ChatLowerInteractionSurfaces (render)", () => {
    it("restores paint/spacing/pointer on the centered column and applies the bottom seal when bottomSpacing is normal", () => {
      // ComposerSlotShell is module-private. Viewer mode mounts it with
      // bottomSpacing="normal" without the real ChatComposer / host stack.
      render(
        <TooltipProvider delayDuration={0}>
          <ChatLowerInteractionSurfaces {...viewerSurfacesProps()} />
        </TooltipProvider>,
      );

      const notice = screen.getByText(
        /Read-only viewer\. The agent owner can send prompts/,
      );
      // The read-only state carries a visual marker, not just the sentence -
      // the same lock glyph the sidebar row and tab strip use.
      expect(
        notice.closest(".rounded-md")?.querySelector("svg.lucide-lock"),
      ).not.toBeNull();
      const centered = notice.closest(".max-w-3xl");
      expect(centered).not.toBeNull();
      const shell = centered?.parentElement;
      expect(shell).not.toBeNull();

      expectEdgeLaneOuterWithCenteredPaint(shell as Element, {
        centeredMustInclude: [
          "relative",
          "pt-4",
          "pb-4",
          "after:pointer-events-none",
          "after:absolute",
          "after:inset-x-0",
          "after:-bottom-px",
          "after:h-px",
          "after:bg-canvas",
          "after:content-['']",
        ],
      });
    });
  });

  describe("ChatComposer chrome (source-shape)", () => {
    // Why not render: ChatComposerImpl pulls tab-host, draft store, toolbar
    // catalog, reauth/pack/rate-limit gates, paste, dictation, prompt stash,
    // and submit hooks. Mounting it for className pins forces the full
    // chat-tile harness; a source pin is the focused regression for the
    // edge-lane vs centered paint split, vertical spacing move, and seal.

    it("keeps full-width wrappers as edge lanes; centered children own bg-canvas, spacing, and the main 1px seal", () => {
      const source = sourceOf("components/chat/composer/chat-composer.tsx");

      // Rate-limit banner: outer edge-lane only; centered owns paint + pt-4.
      expect(source).toMatch(
        /topBannerKind === "rate-limit"[\s\S]*?className="pointer-events-none px-4"[\s\S]*?className="pointer-events-auto mx-auto w-full max-w-3xl bg-canvas pt-4"/,
      );
      // Main composer: outer edge-lane only (no vertical padding / bg-canvas).
      expect(source).toMatch(
        /data-chat-composer="" className="pointer-events-none px-4"/,
      );
      // Centered backplate: relative, paint, pb-4, pointer-free 1px seal with
      // after:content-[''] so the pseudo-element actually renders.
      expect(source).toContain(
        `pointer-events-auto relative mx-auto w-full max-w-3xl bg-canvas pb-4 ${BOTTOM_SEAL_CLASSES}`,
      );
      // Vertical top spacing stays on the centered child, not the outer.
      expect(source).toMatch(
        /data-chat-composer="" className="pointer-events-none px-4"[\s\S]*?topSpacing === "normal" \? "pt-4" : "pt-0"/,
      );

      // Negative: full-width wrappers must not re-own the old paint/spacing.
      expect(source).not.toMatch(
        /data-chat-composer="" className="[^"]*bg-canvas/,
      );
      expect(source).not.toMatch(
        /data-chat-composer="" className="[^"]*\b(pt|pb|py)-/,
      );
      expect(source).not.toMatch(
        /ChatComposerBannerPortal>\s*<div className="[^"]*bg-canvas/,
      );
    });
  });

  describe("ChatTile absolute lower interaction wrapper (source-shape)", () => {
    // Why not render: the absolute lower wrapper only mounts inside
    // ChatTileSessionView after snapshotLoaded, which requires the epic
    // session harness, chat stream, auth, and draft stores used by
    // chat-tile.test.tsx. Isolating the pointer-events split does not need
    // that stack; the production JSX is the contract under test.

    it("cannot capture input or paint over the full-width absolute lower layer", () => {
      const source = sourceOf("components/epic-canvas/renderers/chat-tile.tsx");

      const overlayMatch = source.match(
        /className="([^"]*)"\s*\n\s*data-chat-lower-surfaces-overlay=""/,
      );
      expect(overlayMatch).not.toBeNull();
      const overlayClasses = overlayMatch?.[1] ?? "";
      const overlayTokens = classTokens(overlayClasses);

      // Outer absolute positioning layer is pointer- and paint-transparent
      // across the full pane width (including the scrollbar edge lanes).
      expect(overlayTokens).toEqual(
        new Set([
          "pointer-events-none",
          "absolute",
          "inset-x-0",
          "bottom-0",
          "z-10",
        ]),
      );
      expect(overlayClasses).not.toMatch(/(?:^|\s)(?:after:)?bg-/);
      expect(overlayClasses).not.toContain("after:");
      // Immediate child that used to re-enable hit testing across the full
      // width must also stay transparent; only nested max-w-3xl chrome
      // (dock/composer/shell) restores pointer-events-auto.
      expect(source).toMatch(
        /className="pointer-events-none absolute inset-x-0 bottom-0 z-10[^"]*"[\s\S]*?>\s*<div className="pointer-events-none">/,
      );
      expect(source).not.toMatch(
        /className="pointer-events-none absolute inset-x-0 bottom-0 z-10[^"]*"[\s\S]*?>\s*<div className="pointer-events-auto">/,
      );
    });
  });

  describe("ComposerSlotShell production source (source-shape)", () => {
    it("uses edge-lane outer + centered paint, and only seals when bottomSpacing is normal", () => {
      const source = sourceOf(
        "components/epic-canvas/renderers/chat-tile-lower-surfaces.tsx",
      );

      // Extract ComposerSlotShell body so dock/composer classes elsewhere
      // cannot satisfy the pin.
      const shellMatch = source.match(
        /function ComposerSlotShell\([\s\S]*?\n\}\n\nfunction ReadOnlyComposerNotice/,
      );
      expect(shellMatch).not.toBeNull();
      const shellSource = shellMatch?.[0] ?? "";

      expect(shellSource).toContain('className="pointer-events-none px-4"');
      expect(shellSource).toContain(
        '"pointer-events-auto relative mx-auto w-full max-w-3xl bg-canvas"',
      );
      expect(shellSource).toMatch(
        /props\.topSpacing === "normal" \? "pt-4" : "pt-0"/,
      );
      expect(shellSource).toMatch(
        /props\.bottomSpacing === "normal" \? "pb-4" : "pb-0"/,
      );
      // Conditional seal: only when bottomSpacing === "normal", and it must
      // include after:content-[''] so the pseudo-element is guaranteed to paint.
      expect(shellSource).toContain(
        `props.bottomSpacing === "normal" &&\n            "${BOTTOM_SEAL_CLASSES}"`,
      );
      // Outer must not own paint or vertical spacing.
      expect(shellSource).not.toMatch(
        /className="pointer-events-none px-4[^"]*(pt|pb|bg-canvas)/,
      );
      // Seal must not be unconditional on the base class string.
      expect(shellSource).not.toMatch(
        /"pointer-events-auto relative mx-auto w-full max-w-3xl bg-canvas[^"]*after:h-px/,
      );
    });
  });
});

function emptyRestore(): ChatRestoreContextValue {
  return {
    accessRole: "owner",
    currentUserId: "owner-1",
    activeHostId: "host-1",
    activeTurnStatus: null,
    localSnapshotsClearedAt: null,
    restore: null,
    restoreActionPending: false,
    restoreCheckpoint: vi.fn().mockReturnValue(null),
    accumulatedFileChanges: [],
    revertFileChanges: vi.fn().mockReturnValue(null),
  };
}

function emptyQueue(): ChatSessionState["queue"] {
  return { status: "idle", items: [] };
}

function viewerSurfacesProps(): ChatLowerInteractionSurfacesProps {
  const runtime: ChatLowerRuntimeState = { snapshotLoaded: true };
  const access: ChatLowerAccessState = {
    isViewer: true,
    canAct: false,
    readOnlyNotice: null,
  };
  const turn: ChatLowerTurnState = {
    activeTurnStatus: null,
    stopDisabled: true,
    onStopTurn: () => null,
    steerCapable: false,
    steerProtocolSupported: true,
    getActiveTurnForSteer: () => null,
  };
  const interview: ChatLowerInterviewState = {
    pending: null,
    isBusy: false,
    unanswerable: [],
    unanswerableBusy: false,
    onAnswer: () => null,
    onSkip: () => null,
    onFork: null,
  };
  const approvals: ChatLowerApprovalsState = {
    pendingFileEditApprovals: [],
    pendingApprovals: [],
    onFileEditDecision: () => undefined,
    onApprovalDecision: () => undefined,
  };
  const queue: ChatLowerQueueState = {
    editingItem: null,
    editingItemId: null,
    value: { status: "idle", items: [] },
    resumeRequested: false,
    keepPausedRequested: false,
    onPause: () => null,
    onResume: () => null,
    onEdit: () => undefined,
    onCancel: () => undefined,
    onAbortSteer: () => undefined,
    onCancelEdit: () => undefined,
    onStopBackgroundItem: () => null,
    onStopAllBackgroundItems: () => null,
    onStopBackgroundSession: () => null,
    onReorder: () => undefined,
    onSteerNow: () => undefined,
  };
  const composer: ChatLowerComposerState = {
    sessionSettingsSeed: null,
    fallbackSettingsSeed: null,
    nodeId: "chat-1",
    isActive: false,
    mentionRoots: [],
    fallbackToGlobalMentionRoots: true,
    currentEpicId: "epic-1",
    onSubmitMessage: () => false,
    onSettingsChange: null,
    workspaceControls: null,
    workspaceAvailability: WORKSPACE_COMPOSER_READY,
  };

  return {
    epicId: "epic-1",
    viewTabId: "tab-1",
    chatId: "chat-1",
    hostId: "host-1",
    runtime,
    access,
    turn,
    interview,
    approvals,
    queue,
    composer,
    todo: null,
    restoreContext: emptyRestore(),
    backgroundItems: undefined,
    backgroundStopPendingTaskIds: new Set(),
    backgroundStopAllPending: false,
    backgroundSessionStopPending: false,
    onBackgroundItemClick: () => undefined,
  };
}
