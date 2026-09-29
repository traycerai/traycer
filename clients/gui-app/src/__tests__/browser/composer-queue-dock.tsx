import { useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { LazyMotion, domAnimation } from "motion/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedItem,
  ChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  CHAT_DOCK_PANEL_ROW,
  CHAT_DOCK_PANEL_ROW_TEXT,
} from "@/components/chat/chat-dock-panel-row";
import { ChatLowerDock } from "@/components/chat/chat-lower-dock";
import { ChatDockCompactStripProvider } from "@/components/chat/chat-dock-compact-strip";
import { ChatDiffTargetContext } from "@/components/chat/chat-diff-target";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { ComposerSlotShell } from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import { useChatDockChrome } from "@/components/epic-canvas/renderers/use-chat-dock-chrome";
import { ComposerShell } from "@/components/home/composer/composer-shell";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import {
  SAMPLE_AGENT_DESCENDANTS,
  SAMPLE_CHAT_ID,
  SAMPLE_EPIC_ID,
  SAMPLE_HOST_ID,
  SAMPLE_NO_PENDING_STOPS,
  SAMPLE_QUEUE,
  SAMPLE_RESTORE,
  SAMPLE_SELF_AGENT,
  SAMPLE_TODO,
  SAMPLE_VIEW_TAB_ID,
  sampleNoop,
  sampleNoopAction,
} from "@/components/sample-workspace/sample-workspace-scene";
import { TooltipProvider } from "@/components/ui/tooltip";
import { lowerSurfaceFrame } from "@/lib/chat/chat-lower-scroll-budget";
import type { LayoutPresetId } from "@/lib/layout/layout-presets";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE MESSAGE QUEUE ABOVE THE COMPOSER (staging round 2, G1-G2): the real
 * tile's dock derivation (`useChatDockChrome`) and the real `ChatLowerDock`,
 * over the real composer shell, fed a queue the fixture owns.
 *
 * Typing into the composer and pressing Enter queues a message, the way a send
 * during a running turn does. Todo rides along as the "other" dock member, so
 * the queue is always read next to a surface that DOES fold into a pill in the
 * Compact preset; `__probeDock` adds or removes Files changed and Active agents
 * beside it (staging round 4). `browser-tests/composer-queue-dock.spec.ts`
 * drives it.
 *
 * The composer's top spacing is the tile's OWN decision: this fixture feeds
 * `lowerSurfaceFrame` (the function `ChatLowerInteractionSurfaces` calls) the
 * facts it owns - which members have content, what is queued - and never
 * computes "is the joined frame filled" itself, so what the spec measures is
 * what production decides.
 */
type ChatQueueState = ChatSessionState["queue"];

/** The sample's own queued prompt, re-keyed and re-worded per send. */
function queuedPrompt(index: number, text: string): ChatQueuedPromptItem {
  const template = SAMPLE_QUEUE.items.find((item) => item.kind === "prompt");
  if (template?.kind !== "prompt") {
    throw new Error("the sample queue lost its prompt row");
  }
  const content: JsonContent = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
  return {
    ...template,
    queueItemId: `probe-queue-${index}`,
    messageId: `probe-queue-${index}-message`,
    message: { ...template.message, content },
  };
}

/** Which of the other dock members have something to show. */
interface ProbeDockMembers {
  readonly todo: boolean;
  readonly changes: boolean;
  readonly agents: boolean;
}

interface ProbeWindow extends Window {
  __probePreset?: (preset: LayoutPresetId) => void;
  __probeDock?: (members: ProbeDockMembers) => void;
  __probeTheme?: (mode: "light" | "dark") => void;
  __probeQueueAgentReply?: (text: string) => void;
  /** Empties the queue, agent replies included: those have no Delete. */
  __probeQueueClear?: () => void;
  /** The row recipe every dock panel's one-line row is held to (L-171). */
  __probeRowRecipe?: string;
  __probeReady?: boolean;
}
const probeWindow: ProbeWindow = window;
probeWindow.__probeRowRecipe = cn(
  CHAT_DOCK_PANEL_ROW,
  CHAT_DOCK_PANEL_ROW_TEXT,
);
probeWindow.__probePreset = (preset) => {
  useLayoutStore.getState().applyPreset(preset);
};
probeWindow.__probeTheme = (mode) => {
  useSettingsStore.getState().setTheme(mode);
};

export function ComposerQueueDockFixture(): ReactElement {
  const [pickerStore] = useState(() => createComposerPickerStore());
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState(0);
  const [queue, setQueue] = useState<ChatQueueState>({
    status: "running",
    items: [],
  });
  const [members, setMembers] = useState<ProbeDockMembers>({
    todo: true,
    changes: false,
    agents: false,
  });
  const restore = members.changes
    ? SAMPLE_RESTORE
    : { ...SAMPLE_RESTORE, accumulatedFileChanges: [] };
  const selfAgent = members.agents ? SAMPLE_SELF_AGENT : null;
  const activeAgents = members.agents ? SAMPLE_AGENT_DESCENDANTS : [];
  const todo = members.todo ? SAMPLE_TODO : null;
  const activeAgentsVisible = members.agents;
  const backgroundVisible = false;
  const chrome = useChatDockChrome({
    snapshotLoaded: true,
    chatId: SAMPLE_CHAT_ID,
    restore,
    selfAgent,
    activeAgents,
    activeAgentsVisible,
    backgroundVisible,
    backgroundItems: [],
    runningManagedCommands: [],
    heldManagedCommands: [],
    backgroundFailureToken: null,
    portForwardCount: 0,
    queue,
    todo,
  });
  useEffect(() => {
    probeWindow.__probeDock = setMembers;
    probeWindow.__probeQueueClear = () => {
      setQueue((current) => ({ ...current, items: [] }));
    };
    // A reply another agent queued: the row that carries a provenance badge,
    // which has to measure the same as a user's own one-line row (L-172).
    probeWindow.__probeQueueAgentReply = (text) => {
      setQueue((current) => ({
        ...current,
        items: [
          ...current.items,
          {
            ...queuedPrompt(current.items.length + 100, text),
            sender: {
              type: "agent",
              harnessId: "claude",
              agentId: "probe-sender-agent",
              displayName: "Probe reviewer",
              reply: { expectsReply: false },
              inReplyTo: null,
            },
          },
        ],
      }));
    };
    probeWindow.__probeReady = true;
  }, []);
  const cancel = (item: ChatQueuedItem) => {
    setQueue((current) => ({
      ...current,
      items: current.items.filter(
        (row) => row.queueItemId !== item.queueItemId,
      ),
    }));
  };
  // The real tile's own decision, from the facts this fixture owns: anything
  // in the joined frame tucks into the input, a pills-only dock keeps the
  // composer's own `pt-4`.
  const frame = lowerSurfaceFrame({
    folded: chrome.folded,
    openSection: chrome.openSection,
    todoHasContent: todo !== null,
    filesChangedHasContent: chrome.hotspots.filesChanged.hasContent,
    activeAgentsHasContent: activeAgentsVisible,
    backgroundHasContent: backgroundVisible,
    queueItemCount: queue.items.length,
  });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas text-foreground">
      <div className="min-h-0 flex-1" data-probe-transcript />
      <TabHostContext.Provider value={SAMPLE_HOST_ID}>
        <ChatDiffTargetContext.Provider value={null}>
          <ChatDockCompactStripProvider value={chrome.strip}>
            <ChatLowerDock
              snapshotLoaded
              epicId={SAMPLE_EPIC_ID}
              chatId={SAMPLE_CHAT_ID}
              viewTabId={SAMPLE_VIEW_TAB_ID}
              selfAgent={selfAgent}
              activeAgents={activeAgents}
              todo={todo}
              restore={restore}
              queue={queue}
              folded={chrome.folded}
              dockOrder={chrome.dockOrder}
              hotspots={chrome.hotspots}
              backgroundItems={[]}
              runningManagedCommandCount={0}
              heldManagedCommandCount={0}
              portForwardCount={0}
              backgroundStopPendingTaskIds={SAMPLE_NO_PENDING_STOPS}
              backgroundStopAllPending={false}
              backgroundSessionStopPending={false}
              activeTurnStatus="running"
              canAct
              queueResumeRequested={false}
              queueKeepPausedRequested={false}
              readOnly={false}
              editingQueueItemId={null}
              topSpacing="normal"
              scrollRegionMaxHeightClass="max-h-[min(24dvh,12rem)]"
              onQueuePause={() => {
                setQueue((current) => ({ ...current, status: "paused" }));
                return null;
              }}
              onQueueResume={() => {
                setQueue((current) => ({ ...current, status: "running" }));
                return null;
              }}
              onQueueEdit={sampleNoop}
              onQueueCancel={cancel}
              onQueueAbortSteer={sampleNoop}
              onQueueReorder={sampleNoop}
              onQueueSteerNow={sampleNoop}
              onBackgroundItemClick={sampleNoop}
              onBackgroundItemStop={sampleNoopAction}
              onBackgroundItemsStopAll={sampleNoopAction}
              onBackgroundSessionStop={sampleNoopAction}
            />
            <div className="shrink-0">
              <ComposerSlotShell
                topSpacing={frame.topSpacing}
                bottomSpacing="normal"
              >
                <div className="relative flex flex-col gap-3">
                  <ComposerShell
                    expansion={null}
                    pickerStore={pickerStore}
                    onDragOver={sampleNoop}
                    onDragEnter={sampleNoop}
                    onDragLeave={sampleNoop}
                    onDrop={sampleNoop}
                    dragOverlayVariant={null}
                    utilityRail={null}
                    attachmentsStrip={null}
                    editor={
                      <textarea
                        data-probe-composer
                        aria-label="Message"
                        rows={2}
                        value={draft}
                        placeholder="Enter to queue"
                        className="w-full resize-none bg-transparent pb-5 text-ui outline-none"
                        onChange={(event) => {
                          setDraft(event.target.value);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" || event.shiftKey) return;
                          event.preventDefault();
                          const text = draft.trim();
                          if (text === "") return;
                          const next = sent + 1;
                          setSent(next);
                          setDraft("");
                          setQueue((current) => ({
                            ...current,
                            items: [...current.items, queuedPrompt(next, text)],
                          }));
                        }}
                      />
                    }
                    toolbar={null}
                  />
                </div>
              </ComposerSlotShell>
            </div>
          </ChatDockCompactStripProvider>
        </ChatDiffTargetContext.Provider>
      </TabHostContext.Provider>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(
  <LazyMotion features={domAnimation}>
    <TooltipProvider>
      <ComposerQueueDockFixture />
    </TooltipProvider>
  </LazyMotion>,
);
