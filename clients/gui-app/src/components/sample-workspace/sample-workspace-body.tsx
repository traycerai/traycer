import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { resolveMinimapVisibleItemCapacity } from "@/components/minimap/minimap-track-geometry";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  useLayoutRegion,
  useRegionGhost,
} from "@/components/layout-editor/use-layout-region";
import { LayoutClusterContextMenu } from "@/components/layout-editor/region-quick-verbs";
import {
  ChatLowerDock,
  type DockRowHotspot,
} from "@/components/chat/chat-lower-dock";
import { dockMemberFolded } from "@/components/chat/chat-dock-fold";
import { ChatDockCompactStripProvider } from "@/components/chat/chat-dock-compact-strip";
import type { ChatDockSection } from "@/lib/chat/chat-dock-sections";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  ChatDiffTargetContext,
  type ChatSnapshotDiffOpener,
} from "@/components/chat/chat-diff-target";
import { buildChatActivityTimeline } from "@/components/chat/chat-activity-groups";
import { ChatSenderOverline } from "@/components/chat/chat-message-timestamp";
import { ActivityGroupSegment } from "@/components/chat/segments/activity-group-segment";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import {
  ChatUserMessageContent,
  UserMessageBubble,
} from "@/components/chat/chat-user-message-content";
import { TextSegment } from "@/components/chat/segments/text-segment";
import { ChatTurnMinimapView } from "@/components/chat/chat-turn-minimap";
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import { ComposerSlotShell } from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import { ComposerShell } from "@/components/home/composer/composer-shell";
import { ComposerWorkspaceRow } from "@/components/home/composer/composer-workspace-mode-row";
import { ComposerTileIdProvider } from "@/components/home/composer/composer-tile-context";
import { ComposerToolbar } from "@/components/home/toolbar/composer-toolbar";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import {
  useArrangementValue,
  useReadingWidthStyle,
  useRegionShown,
  useRegionValues,
} from "@/lib/layout-overrides";
import { chatDockSection } from "@/lib/chat/chat-dock-sections";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { SampleWorkspaceSidebar } from "./sample-workspace-sidebar";
import { SampleModelPicker } from "./sample-model-picker";
import {
  CONTEXT_USAGE_PREVIEW_SAMPLE,
  SAMPLE_AGENT_DESCENDANTS,
  SAMPLE_BACKGROUND_ITEMS,
  SAMPLE_CHAT_ID,
  SAMPLE_DICTATION,
  SAMPLE_DOCK,
  SAMPLE_EPIC_ID,
  SAMPLE_HOST_ID,
  SAMPLE_MINIMAP_ITEMS,
  SAMPLE_NO_PENDING_STOPS,
  SAMPLE_QUEUE,
  SAMPLE_RESTORE,
  SAMPLE_SELF_AGENT,
  SAMPLE_TILE_ID,
  SAMPLE_TODO,
  SAMPLE_TOOLBAR_VALUES,
  SAMPLE_TURN_ACTIVITY,
  SAMPLE_TURNS,
  sampleSentAt,
  SAMPLE_VIEW_TAB_ID,
  sampleNoop,
  sampleNoopAction,
} from "./sample-workspace-scene";
import { cn } from "@/lib/utils";

/**
 * The diff openers the changed-files panel asks for before it draws "Review
 * all". Real handler shapes with nothing behind them: the panel's own gate is
 * "is there an opener", so a null context would silently drop the action and
 * the sample would go on missing the header button L-98 is about.
 */
const SAMPLE_DIFF_OPENER: ChatSnapshotDiffOpener = {
  segment: () => ({ onClick: sampleNoop, onDoubleClick: sampleNoop }),
  cumulative: () => ({ onClick: sampleNoop, onDoubleClick: sampleNoop }),
  cumulativeBundle: () => sampleNoop,
  hash: () => ({ onClick: sampleNoop, onDoubleClick: sampleNoop }),
};

export function SampleWorkspaceBody() {
  const [pickerStore] = useState(() => createComposerPickerStore());
  const [toolbarStore] = useState(() =>
    createComposerToolbarStore({
      seedKey: SAMPLE_TILE_ID,
      purpose: "run",
      reasoningFallback: "model-default",
      values: SAMPLE_TOOLBAR_VALUES,
      onSettingsChange: null,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: null,
    }),
  );
  const dockOrder = useArrangementValue("dock").map(chatDockSection);
  const changedFiles = useRegionValues("changedFiles");
  const runningAgents = useRegionValues("runningAgents");
  const backgroundValues = useRegionValues("background");
  const files = useLayoutRegion({
    regionId: "changedFiles",
    instanceId: SAMPLE_TILE_ID,
  });
  const agents = useLayoutRegion({
    regionId: "runningAgents",
    instanceId: SAMPLE_TILE_ID,
  });
  const background = useLayoutRegion({
    regionId: "background",
    instanceId: SAMPLE_TILE_ID,
  });
  // Todo is a dock region with the same Full row / Chip / Hidden semantics as
  // the other three (L-139), so the canvas has to draw it the same way.
  const todoValues = useRegionValues("todo");
  const todo = useLayoutRegion({
    regionId: "todo",
    instanceId: SAMPLE_TILE_ID,
  });
  const panelId = useId();
  // Every dock member HAS content here (L-98): the sample scene feeds the real
  // panels, so a row draws its own header, its actions and its body exactly as
  // a live chat's does rather than a look-alike header.
  const hotspots: Readonly<Record<ChatDockSection, DockRowHotspot>> = {
    filesChanged: {
      hotspotRef: files.ref,
      editing: files.editing,
      shown: changedFiles.shown === "shown",
      hasContent: true,
      ghost: files.ghost,
    },
    activeAgents: {
      hotspotRef: agents.ref,
      editing: agents.editing,
      shown: runningAgents.shown === "shown",
      hasContent: true,
      ghost: agents.ghost,
    },
    background: {
      hotspotRef: background.ref,
      editing: background.editing,
      shown: backgroundValues.shown === "shown",
      hasContent: true,
      ghost: background.ghost,
    },
    todo: {
      hotspotRef: todo.ref,
      editing: todo.editing,
      shown: todoValues.shown === "shown",
      hasContent: true,
      ghost: todo.ghost,
    },
  };
  // The same derivation the real tile folds on, ghost included: a member that
  // is Hidden AND Chip has to materialise as the CHIP the editor is pointing
  // at, not as the full row it never draws at rest.
  const chipFolded: Readonly<Record<ChatDockSection, boolean>> = {
    filesChanged: dockMemberFolded({
      values: changedFiles,
      ghost: files.ghost,
      hasContent: true,
    }),
    activeAgents: dockMemberFolded({
      values: runningAgents,
      ghost: agents.ghost,
      hasContent: true,
    }),
    background: dockMemberFolded({
      values: backgroundValues,
      ghost: background.ghost,
      hasContent: true,
    }),
    todo: dockMemberFolded({
      values: todoValues,
      ghost: todo.ghost,
      hasContent: true,
    }),
  };
  const folded = new Set<ChatDockSection>(
    dockOrder.filter((section) => chipFolded[section]),
  );
  const chips = dockOrder.flatMap((section) => {
    const sample = SAMPLE_DOCK.find((item) => item.section === section);
    return folded.has(section) && sample
      ? [{ ...sample, hotspotRef: hotspots[section].hotspotRef }]
      : [];
  });
  const sidebarSide = useArrangementValue("sidebarSide");
  // The real composer draws no mic while Voice input is off; the scene still
  // draws it so the user can find it, dimmed the way the form greys its row,
  // and its menu offers to turn Voice input on (C4).
  const voiceInputEnabled = useSettingsStore(
    (state) => state.voiceInputEnabled,
  );
  return (
    <ComposerTileIdProvider tileId={SAMPLE_TILE_ID}>
      <div className="flex min-h-0 flex-1 bg-canvas" data-sample-workspace-body>
        {/* DOM order follows `sidebarSide` (S-06), never CSS `order`, so the
            layout editor's sample scene shows the real side. */}
        {sidebarSide === "right" ? null : <SampleWorkspaceSidebar />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SampleTranscript />
          {/* The two contexts the real dock panels resolve before they draw:
              the tab's host (the Background panel and the agent stop buttons
              read it) and the diff opener (the changed-files panel's "Review
              all"). Both name the sample scene, so every store they consult
              answers empty and the panels show the sample data below and
              nothing of the user's own work. */}
          <TabHostContext.Provider value={SAMPLE_HOST_ID}>
            <ChatDiffTargetContext.Provider value={SAMPLE_DIFF_OPENER}>
              <ChatDockCompactStripProvider
                // Always closed on the canvas: the editor's firewall swallows
                // clicks, so a pill never opens here and the picture the user
                // customises is the resting one (L-142).
                value={{
                  chips,
                  openSection: null,
                  panelId,
                  onToggle: sampleNoop,
                }}
              >
                <ChatLowerDock
                  snapshotLoaded
                  epicId={SAMPLE_EPIC_ID}
                  chatId={SAMPLE_CHAT_ID}
                  viewTabId={SAMPLE_VIEW_TAB_ID}
                  selfAgent={SAMPLE_SELF_AGENT}
                  activeAgents={SAMPLE_AGENT_DESCENDANTS}
                  todo={SAMPLE_TODO}
                  restore={SAMPLE_RESTORE}
                  queue={SAMPLE_QUEUE}
                  folded={folded}
                  dockOrder={dockOrder}
                  hotspots={hotspots}
                  backgroundItems={SAMPLE_BACKGROUND_ITEMS}
                  runningManagedCommandCount={0}
                  heldManagedCommandCount={0}
                  portForwardCount={0}
                  backgroundStopPendingTaskIds={SAMPLE_NO_PENDING_STOPS}
                  backgroundStopAllPending={false}
                  backgroundSessionStopPending={false}
                  activeTurnStatus={null}
                  canAct
                  queueResumeRequested={false}
                  queueKeepPausedRequested={false}
                  readOnly={false}
                  editingQueueItemId={null}
                  // "normal" (`pt-4`), the same answer the real tile gives
                  // whenever no approval surface is drawn above the dock
                  // (`pinnedStackTopSpacing`). The scene had "compact"
                  // (`pt-2`) with nothing above it to be compact for.
                  topSpacing="normal"
                  scrollRegionMaxHeightClass="max-h-[min(24dvh,12rem)]"
                  onQueuePause={sampleNoopAction}
                  onQueueResume={sampleNoopAction}
                  onQueueEdit={sampleNoop}
                  onQueueCancel={sampleNoop}
                  onQueueAbortSteer={sampleNoop}
                  onQueueReorder={sampleNoop}
                  onQueueSteerNow={sampleNoop}
                  onBackgroundItemClick={sampleNoop}
                  onBackgroundItemStop={sampleNoopAction}
                  onBackgroundItemsStopAll={sampleNoopAction}
                  onBackgroundSessionStop={sampleNoopAction}
                />
                {/* The REAL composer stack, not a copy of its classes
                    (L-87): `ComposerSlotShell` owns the edge lanes, the
                    reading column, the canvas fill, the top and bottom
                    spacing and the seam seal, and `relative flex flex-col
                    gap-3` is the composer's own inner rhythm
                    (`chat-composer.tsx`). The scene used to hand-roll both
                    and had drifted to no vertical spacing at all, which is
                    why the pills read as stuck to the input here and nowhere
                    else (L-153).

                    `shrink-0` is the one thing the sample adds, and it is
                    about this scene rather than about the composer: the real
                    lower surfaces are an absolutely positioned overlay, while
                    here they are a flex child under a scrolling transcript.

                    Always `connected`, the answer the real tile gives
                    whenever its frame has anything in it: the sample queue
                    is never empty, and the queue always sits in the frame,
                    tucked into the input with `-mb-px` (G1-G2). */}
                <div className="shrink-0">
                  <ComposerSlotShell
                    topSpacing="connected"
                    bottomSpacing="normal"
                  >
                    {/* Its Model chip anchors the sample picker
                        (`layout-editor.css`). */}
                    <div
                      data-sample-model-anchor
                      className={cn(
                        "relative flex flex-col gap-3",
                        !voiceInputEnabled &&
                          "[&_[data-layout-region=mic]]:opacity-45",
                      )}
                    >
                      {/* Ahead of the chip in document order on purpose:
                          it is a part of the Model region, not its node, so
                          no lookup of the region depends on which comes
                          first. */}
                      <SampleModelPicker />
                      <ComposerShell
                        pickerStore={pickerStore}
                        onDragOver={sampleNoop}
                        onDragEnter={sampleNoop}
                        onDragLeave={sampleNoop}
                        onDrop={sampleNoop}
                        dragOverlayVariant={null}
                        utilityRail={null}
                        expansion={null}
                        attachmentsStrip={null}
                        editor={
                          // No marker of its own: `ComposerShell` already marks
                          // `data-composer-editor-frame`, which this placeholder
                          // renders inside, and a second marker on a descendant
                          // would dim it twice.
                          <p className="pb-5 text-ui text-muted-foreground">
                            Describe the next change…
                          </p>
                        }
                        toolbar={
                          <ComposerToolbar
                            presentation
                            store={toolbarStore}
                            onAttachImages={sampleNoop}
                            canSubmit={false}
                            attachmentPending={false}
                            onSubmit={sampleNoop}
                            activeTurnStatus={null}
                            stopDisabled
                            onStopTurn={null}
                            composerDisabledHint="Sample content"
                            // The mic slot draws nothing without a control, so a
                            // Microphone set to Shown had no chip to point at
                            // (L-116). The scene's idle control is what the real
                            // `ComposerMicButton` renders from.
                            dictation={SAMPLE_DICTATION}
                            dictationPreparing={null}
                            settingsLocked
                            createProfileHostId={null}
                            runTargetHostId={null}
                            terminalLoginSurface={null}
                            chatLineCarriesAutoMode={null}
                          />
                        }
                      />
                      <ComposerWorkspaceRow
                        workspaceControls={
                          <>
                            {/* The workspace chips' cell, left empty: the sample
                                notice above the canvas is the one caption, so
                                there is no second one here (design craft 2.3). */}
                            <span />
                            <ContextUsageChip
                              usage={CONTEXT_USAGE_PREVIEW_SAMPLE}
                              onCompact={sampleNoop}
                            />
                          </>
                        }
                      />
                    </div>
                  </ComposerSlotShell>
                </div>
              </ChatDockCompactStripProvider>
            </ChatDiffTargetContext.Provider>
          </TabHostContext.Provider>
        </div>
        {sidebarSide === "right" ? <SampleWorkspaceSidebar /> : null}
      </div>
    </ComposerTileIdProvider>
  );
}

const SAMPLE_NO_PROMOTED_BLOCKS: ReadonlySet<string> = new Set();

/**
 * One sample turn's agent work, through the same timeline builder and the same
 * activity row the transcript uses, so Tool activity and Thinking are drawn -
 * and open, fold or hide - exactly as they would in a chat. The rows name
 * themselves as regions, which is what makes them canvas targets.
 *
 * Passive by construction: a fresh open store per mount, and commands that
 * have already finished, so nothing streams, fetches or persists.
 */
function SampleTurnActivity(props: {
  readonly turnIndex: number;
  readonly hideReasoning: boolean;
}) {
  const segments = SAMPLE_TURN_ACTIVITY[props.turnIndex] ?? [];
  if (segments.length === 0) return null;
  const timeline = buildChatActivityTimeline(segments, {
    turnState: "complete",
    promotedToolBlockIds: SAMPLE_NO_PROMOTED_BLOCKS,
    hideReasoning: props.hideReasoning,
  });
  return timeline.map((item) =>
    item.kind === "activity_group" ? (
      <ActivityGroupSegment key={item.id} group={item.group} />
    ) : null,
  );
}

function SampleTranscript() {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [capacity, setCapacity] = useState(12);
  const readingWidth = useReadingWidthStyle();
  // Thinking hidden leaves the reasoning run out, as the real transcript does,
  // unless the editor is pointing at it (L-14).
  const thinkingShown = useRegionShown("thinking");
  const thinkingGhost = useRegionGhost("thinking");
  const hideReasoning = !(thinkingShown || thinkingGhost);
  const shown = useRegionShown("minimap");
  const side = useArrangementValue("minimapSide");
  const coarsePointer = useCoarsePointer();
  const { ref: minimapRef, ghost: minimapGhost } = useLayoutRegion({
    regionId: "minimap",
    instanceId: SAMPLE_TILE_ID,
  });
  // Hidden is absent at rest and the real rail while the editor points at it
  // (L-14), as in the real transcript.
  const minimapDrawn = shown || minimapGhost;
  useEffect(() => {
    const scroller = viewport.current;
    const turns = content.current;
    if (!scroller || !turns) return;
    // Open at the latest turn, the way a real chat does.
    //
    // This is the slice the owner's recording shows: the scroller opened at
    // the TOP, so its bottom edge landed wherever a line happened to be and
    // the dock's opaque band cut that line in half. Scrolled to the end, the
    // scroller's bottom edge lands on the content's own `py-6`, and the last
    // thing above the dock is whitespace rather than half a sentence.
    scroller.scrollTop = scroller.scrollHeight;
    const measure = () => {
      const nodes = Array.from(
        turns.querySelectorAll<HTMLElement>("[data-sample-turn]"),
      );
      const top = scroller.getBoundingClientRect().top;
      const firstBelow = nodes.findIndex(
        (node) => node.getBoundingClientRect().bottom > top,
      );
      setCurrentIndex(Math.max(0, firstBelow));
      setCapacity(resolveMinimapVisibleItemCapacity(scroller.clientHeight));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(turns);
    scroller.addEventListener("scroll", measure);
    measure();
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", measure);
    };
  }, []);
  let minimap: ReactNode = null;
  if (minimapDrawn && coarsePointer)
    minimap = (
      <div
        ref={minimapRef}
        className={cn(
          "absolute top-1/2 rounded border border-dashed p-2 text-ui-xs text-muted-foreground",
          side === "left" ? "left-3" : "right-3",
        )}
      >
        Minimap is unavailable with a coarse pointer
      </div>
    );
  else if (minimapDrawn)
    minimap = (
      <ChatTurnMinimapView
        items={SAMPLE_MINIMAP_ITEMS}
        currentIndex={currentIndex}
        cursorIndex={currentIndex}
        maxVisibleItems={capacity}
        bottomInset={0}
        hitStripWidth={24}
        side={side}
        open={false}
        ref={minimapRef}
        hitStripRef={null}
        onOpen={sampleNoop}
        onFocus={sampleNoop}
        onKeyDown={sampleNoop}
        onCursorIndexChange={sampleNoop}
        onSelect={sampleNoop}
      />
    );
  return (
    // One menu for the whole transcript, naming the region under the pointer
    // (G3-10): the timestamps, activity rows and the minimap - the rail or
    // the stand-in that explains why there is none (L-144).
    <LayoutClusterContextMenu>
      <div className="relative min-h-0 flex-1">
        {/* The conversation's CONTENT is marked passive leaf by leaf - each
          prompt bubble and each reply - so it reads as calm content under lit
          chrome (C-03, L-87). Not the scroller: the transcript now holds
          regions of its own (the activity rows and the timestamps, L-175,
          L-178), and a marker on their ancestor would dim them with it. The
          minimap region is a SIBLING of this scroller for the same reason. */}
        <ChatFindForceStoreProvider tileInstanceId={SAMPLE_TILE_ID}>
          <ActivityGroupOpenStoreProvider store={null}>
            <div
              ref={viewport}
              className="h-full overflow-y-auto"
              aria-label="Sample conversation"
            >
              {/* The real row's column and inset (`chat-timeline.tsx`), so the
                sample reads at a chat's width and clears the minimap. */}
              <div
                ref={content}
                className={cn(
                  "mx-auto w-full space-y-8 px-6 py-6",
                  readingWidth.className,
                )}
                style={{ maxWidth: readingWidth.maxWidth }}
              >
                {SAMPLE_TURNS.map((turn, index) => (
                  <div key={turn.prompt} data-sample-turn className="space-y-4">
                    {/* The real sender overline, so the stamp in it is the
                      Timestamps region itself. */}
                    <div className="flex flex-col items-end gap-1.5">
                      <ChatSenderOverline
                        label="You"
                        sentAt={sampleSentAt(index)}
                        stamped
                        instanceId={`sample-turn-${index}`}
                      />
                      <div data-layout-passive className="w-fit max-w-full">
                        <UserMessageBubble>
                          <ChatUserMessageContent
                            content={turn.prompt}
                            attachments={[]}
                          />
                        </UserMessageBubble>
                      </div>
                    </div>
                    <SampleTurnActivity
                      turnIndex={index}
                      hideReasoning={hideReasoning}
                    />
                    <div data-layout-passive>
                      <TextSegment
                        findUnitId={null}
                        markdown={turn.reply}
                        isStreaming={false}
                        nextStepActions={null}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </ActivityGroupOpenStoreProvider>
        </ChatFindForceStoreProvider>
        {minimap}
      </div>
    </LayoutClusterContextMenu>
  );
}
