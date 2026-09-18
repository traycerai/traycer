import { resolveMinimapVisibleItemCapacity } from "@/components/minimap/minimap-track-geometry";
import { useEffect, useRef, useState } from "react";
import { Wrench } from "lucide-react";
import { useLayoutHotspot } from "@/components/customize/use-layout-hotspot";
import { CustomizeDropSlot } from "@/components/customize/customize-drop-slot";
import {
  ChatLowerDock,
  type DockRowHotspot,
} from "@/components/chat/chat-lower-dock";
import {
  ChatDockCompactStrip,
  ChatDockCompactStripProvider,
} from "@/components/chat/chat-dock-compact-strip";
import type { ChatDockSection } from "@/components/chat/chat-dock-compact-context";
import { ActiveAgentsHeader } from "@/components/chat/chat-active-agents-panel";
import { BackgroundItemsHeader } from "@/components/chat/chat-background-items-panel";
import { FileChangeHeader } from "@/components/chat/segments/file-change-segment";
import { SegmentRow } from "@/components/chat/segments/segment-row";
import {
  ChatUserMessageContent,
  UserMessageBubble,
} from "@/components/chat/chat-user-message-content";
import { TextSegment } from "@/components/chat/segments/text-segment";
import { ChatTurnMinimapView } from "@/components/chat/chat-turn-minimap";
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import { ComposerShell } from "@/components/home/composer/composer-shell";
import { ComposerWorkspaceRow } from "@/components/home/composer/composer-workspace-mode-row";
import { ComposerTileIdProvider } from "@/components/home/composer/composer-tile-context";
import { ComposerToolbar } from "@/components/home/toolbar/composer-toolbar";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { Collapsible } from "@/components/ui/collapsible";
import { useComposerLayout, useLayoutSetting } from "@/lib/layout-overrides";
import { SampleWorkspaceRail } from "./sample-workspace-rail";
import {
  CONTEXT_USAGE_PREVIEW_SAMPLE,
  SAMPLE_CHANGED_FILE,
  SAMPLE_AGENT,
  SAMPLE_BACKGROUND,
  SAMPLE_TOOLBAR_VALUES,
  SAMPLE_DOCK,
  SAMPLE_MINIMAP_ITEMS,
  SAMPLE_TILE_ID,
  SAMPLE_TURNS,
  sampleNoop,
} from "./sample-workspace-scene";
import { cn } from "@/lib/utils";

export function SampleWorkspaceBody() {
  const [pickerStore] = useState(() => createComposerPickerStore());
  const [toolbarStore] = useState(() =>
    createComposerToolbarStore({
      seedKey: SAMPLE_TILE_ID,
      values: SAMPLE_TOOLBAR_VALUES,
      onSettingsChange: null,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: null,
    }),
  );
  const composer = useComposerLayout();
  const files = useLayoutHotspot({
    settingId: "composer.filesChanged",
    tileId: SAMPLE_TILE_ID,
    ghost: false,
    condition: null,
  });
  const agents = useLayoutHotspot({
    settingId: "composer.activeAgents",
    tileId: SAMPLE_TILE_ID,
    ghost: false,
    condition: null,
  });
  const background = useLayoutHotspot({
    settingId: "composer.background",
    tileId: SAMPLE_TILE_ID,
    ghost: false,
    condition: null,
  });
  const hotspots: Readonly<Record<ChatDockSection, DockRowHotspot>> = {
    filesChanged: {
      hotspotRef: files.ref,
      editing: files.editing,
      ghost: false,
      condition: "",
    },
    activeAgents: {
      hotspotRef: agents.ref,
      editing: agents.editing,
      ghost: false,
      condition: "",
    },
    background: {
      hotspotRef: background.ref,
      editing: background.editing,
      ghost: false,
      condition: "",
    },
  };
  const folded = new Set(
    composer.dockOrder.filter((section) => composer[section] === "compact"),
  );
  const chips = composer.dockOrder.flatMap((section) => {
    const sample = SAMPLE_DOCK.find((item) => item.section === section);
    return folded.has(section) && sample
      ? [{ ...sample, hotspotRef: hotspots[section].hotspotRef }]
      : [];
  });
  return (
    <ComposerTileIdProvider tileId={SAMPLE_TILE_ID}>
      <div className="flex min-h-0 flex-1 bg-canvas" data-sample-workspace-body>
        <SampleWorkspaceRail />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SampleTranscript />
          <div inert className="contents">
            <ChatDockCompactStripProvider
              value={{ chips, expanded: new Set(), onToggle: sampleNoop }}
            >
              <ChatLowerDock
                folded={folded}
                dockOrder={composer.dockOrder}
                hotspots={hotspots}
                topSpacing="compact"
                presentationRows={{
                  filesChanged: (
                    <div className="flex items-center gap-2 px-3 py-2">
                      <span className="text-ui-xs text-muted-foreground">
                        Sample
                      </span>
                      <FileChangeHeader
                        filePath={SAMPLE_CHANGED_FILE.path}
                        operation="edit"
                        additions={SAMPLE_CHANGED_FILE.additions}
                        deletions={SAMPLE_CHANGED_FILE.deletions}
                        isStreaming={false}
                        endState={null}
                        reason="snapshot"
                        clickHandlers={null}
                      />
                    </div>
                  ),
                  activeAgents: (
                    <Collapsible open={false} variant="panel">
                      <ActiveAgentsHeader
                        open={false}
                        runningCount={SAMPLE_AGENT.count}
                      />
                      <p className="px-3 pb-2 text-ui-xs text-muted-foreground">
                        {SAMPLE_AGENT.label}
                      </p>
                    </Collapsible>
                  ),
                  background: (
                    <Collapsible open={false} variant="panel">
                      <BackgroundItemsHeader
                        open={false}
                        headerSummary={`${SAMPLE_BACKGROUND.count} running`}
                      />
                      <p className="px-3 pb-2 text-ui-xs text-muted-foreground">
                        {SAMPLE_BACKGROUND.label}
                      </p>
                    </Collapsible>
                  ),
                }}
              />
              <div className="shrink-0 px-4 pb-2">
                <div className="mx-auto w-full max-w-3xl">
                  <ComposerShell
                    pickerStore={pickerStore}
                    onDragOver={sampleNoop}
                    onDragEnter={sampleNoop}
                    onDragLeave={sampleNoop}
                    onDrop={sampleNoop}
                    dragOverlayVariant={null}
                    utilityRail={null}
                    attachmentsStrip={null}
                    editor={
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
                        dictation={null}
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
                        <span className="min-w-0 text-ui-xs text-muted-foreground">
                          Sample workspace
                        </span>
                        <ChatDockCompactStrip />
                        <ContextUsageChip
                          usage={CONTEXT_USAGE_PREVIEW_SAMPLE}
                          onCompact={sampleNoop}
                        />
                      </>
                    }
                  />
                </div>
              </div>
            </ChatDockCompactStripProvider>
          </div>
        </div>
      </div>
    </ComposerTileIdProvider>
  );
}

function SampleTranscript() {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [capacity, setCapacity] = useState(12);
  const side = useLayoutSetting("chatTurnMinimapSide");
  const { ref: minimapRef } = useLayoutHotspot({
    settingId: "chat.minimapSide",
    tileId: SAMPLE_TILE_ID,
    ghost: side === "hide",
    condition: side === "hide" ? "Hidden" : null,
  });
  useEffect(() => {
    const scroller = viewport.current;
    const turns = content.current;
    if (!scroller || !turns) return;
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
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={viewport}
        className="h-full overflow-y-auto px-4"
        aria-label="Sample conversation"
      >
        <div inert ref={content} className="mx-auto max-w-3xl space-y-8 py-6">
          {SAMPLE_TURNS.map((turn, index) => (
            <div key={turn.prompt} data-sample-turn className="space-y-4">
              <div className="ml-auto w-fit max-w-full">
                <UserMessageBubble>
                  <ChatUserMessageContent
                    content={turn.prompt}
                    attachments={[]}
                  />
                </UserMessageBubble>
              </div>
              {index === 0 ? (
                <SegmentRow
                  open={false}
                  onOpenChange={sampleNoop}
                  header={
                    <>
                      <Wrench className="size-4" />
                      <span>Read {SAMPLE_CHANGED_FILE.path} · Sample tool</span>
                    </>
                  }
                  headerAction={null}
                  body={null}
                  tone="default"
                  stickyHeader={false}
                  headerFindUnitId={null}
                  bodyFindUnitId={null}
                  expandable={false}
                  className={undefined}
                  footer={null}
                />
              ) : null}
              <TextSegment
                findUnitId={null}
                markdown={turn.reply}
                isStreaming={false}
                nextStepActions={null}
              />
            </div>
          ))}
        </div>
      </div>
      {side === "hide" ? (
        <div
          ref={minimapRef}
          className="absolute right-3 top-1/2 rounded border border-dashed p-2 text-ui-xs text-muted-foreground"
        >
          Hidden minimap
        </div>
      ) : (
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
      )}
      {(["left", "right"] as const).map((edge) => (
        <CustomizeDropSlot
          key={edge}
          id={`minimap:${edge}`}
          group="chat-minimap"
          tileId={SAMPLE_TILE_ID}
          className={cn(
            "absolute top-1/2 h-12 w-6",
            edge === "left" ? "left-0" : "right-0",
          )}
        />
      ))}
    </div>
  );
}
