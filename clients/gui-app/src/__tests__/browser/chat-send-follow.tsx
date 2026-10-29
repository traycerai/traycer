import { useState, type ReactElement } from "react";
import { useMeasuredElementHeight } from "@/hooks/ui/use-measured-element-height";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { LazyMotion, domAnimation } from "motion/react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { useStore } from "zustand";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  Chat,
  ChatEvent,
} from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatActiveTurn,
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  ChatComposer,
  type ChatComposerSubmitInput,
} from "@/components/chat/composer/chat-composer";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import {
  EpicSessionContext,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { ChatDockCompactStripProvider } from "@/components/chat/chat-dock-compact-strip";
import { ChatDiffTargetContext } from "@/components/chat/chat-diff-target";
import { ChatLowerDock } from "@/components/chat/chat-lower-dock";
import {
  queuedPromptMessageIds,
  queueWithoutPersistedPrompts,
} from "@/components/chat/chat-queue-utils";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  ChatSessionMessagesSurface,
  type ChatSessionMessagesSurfaceProps,
} from "@/components/epic-canvas/renderers/chat-tile";
import { useChatDockChrome } from "@/components/epic-canvas/renderers/use-chat-dock-chrome";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import {
  SAMPLE_NO_PENDING_STOPS,
  SAMPLE_RESTORE,
  sampleNoop,
  sampleNoopAction,
} from "@/components/sample-workspace/sample-workspace-scene";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  composerTurnStatus,
  resolvedTurnStatus,
} from "@/stores/chats/chat-run-activity";
import {
  createChatSessionStore,
  projectQueueWithPendingCancellations,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { queueWithDrainingPrompts } from "@/stores/chats/chat-send-state";
import { useRenderedMessages } from "@/stores/chats/rendered-messages";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * A SEND INTO A CHAT, end to end: the real chat session store, fed scripted
 * host frames, over the real `useRenderedMessages` and the tile's own
 * `ChatSessionMessagesSurface` (verb latch + `ChatMessages` list) and the real
 * `ChatLowerDock`. Nothing here decides where a prompt goes or how a working
 * row looks; the fixture only plays the host and reads.
 *
 * `window.__followDriver` is the driver. `host.*` are the frames the host sends;
 * `send` is the person pressing Enter. `browser-tests/chat-send-owns-turn.spec.ts`
 * drives it and measures the DOM.
 */

const EPIC_ID = "epic-follow";
const CHAT_ID = "chat-follow";
const OWNER_ID = "owner-send";
const HOST_ID = "host-send";

const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

type ScenarioKind = "idle" | "background-only" | "activating" | "running";

interface SendOptions {
  readonly image: boolean;
}

interface SendDriver {
  open: (kind: ScenarioKind) => void;
  send: (text: string, options: SendOptions) => string;
  host: {
    accept: (messageId: string) => void;
    turnStarted: (messageId: string) => void;
    queueAdded: (messageId: string) => void;
    queueRemoved: () => void;
    earlierTurnEnded: () => void;
    setupCreating: (messageId: string) => void;
    /** Streams `tokens` words into the reply, one per `intervalMs`. */
    streamReply: (tokens: number, intervalMs: number) => void;
    stopReply: () => void;
    /** Short text blocks (4-6 tokens) each followed by a tool card: new row keys. */
    streamParts: (parts: number) => void;
    /** Text tokens 30-60ms apart with a 80-150ms gap every 9th token. */
    streamBursty: (tokens: number, blockId: string) => void;
    /** Reasoning, text, then a tool call, `cycles` times, one event per tick. */
    streamRich: (prefix: string, cycles: number, intervalMs: number) => void;
  };
  probe: () => ScrollProbe;
  /** The message id of the last send the composer made, or `null`. */
  lastMessageId: () => string | null;
  ready: boolean;
}

interface ScrollProbe {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly distance: number;
  readonly mode: string | null;
  readonly pill: boolean;
  readonly dockHeight: number;
  readonly promptTop: number | null;
  readonly promptBottom: number | null;
  readonly rows: number;
  readonly lastRowKey: string | null;
}

interface ProbeWindow extends Window {
  __followDriver?: SendDriver;
}
const probeWindow: ProbeWindow = window;

let callbacks: ChatStreamCallbacks | null = null;
const handle = createChatSessionStore({
  environment: CHAT_STORE_TEST_ENVIRONMENT,
  hostId: HOST_ID,
  epicId: EPIC_ID,
  chatId: CHAT_ID,
  userId: OWNER_ID,
  onAuthError: null,
  onProviderAuthError: null,
  wakeTransport: null,
  streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
  streamClientFactory: (_epicId, _chatId, next) => {
    callbacks = next;
    return {
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => false,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    };
  },
});

function liveCallbacks(): ChatStreamCallbacks {
  if (callbacks === null) throw new Error("the store has no stream yet");
  return callbacks;
}

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function promptContent(text: string, image: boolean): JsonContent {
  const paragraph: JsonContent = {
    type: "paragraph",
    content: [{ type: "text", text }],
  };
  if (!image) return { type: "doc", content: [paragraph] };
  return {
    type: "doc",
    content: [
      paragraph,
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "probe-image",
              fileName: "probe.png",
              b64content: PNG_1X1,
              hash: null,
              mimeType: "image/png",
              size: 68,
            },
          },
        ],
      },
    ],
  };
}

function earlierTurn(kind: "starting" | "running"): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId: "turn-earlier",
    status: kind,
    harnessId: "claude",
    model: "claude-sonnet-4-5",
    profileId: null,
    userMessageId: "message-earlier",
    startedAt: 100,
    updatedAt: 100,
    reasoningEffort: null,
    serviceTier: null,
  };
}

const SEED_TURNS = 36;

function seededMessages(withEarlier: boolean): Chat["messages"] {
  const out: Chat["messages"][number][] = [];
  for (let turn = 0; turn < SEED_TURNS; turn += 1) {
    out.push({
      role: "user",
      messageId: `seed-user-${String(turn)}`,
      sender: { type: "user", userId: OWNER_ID },
      message: {
        kind: "user",
        content: promptContent(`Seed question ${String(turn)}`, false),
        browserAnnotations: [],
      },
      timestamp: 10 + turn * 2,
      sessionAnchor: null,
    });
    out.push({
      role: "assistant",
      messageId: `seed-assistant-${String(turn)}`,
      sender: {
        type: "agent",
        harnessId: "claude",
        agentId: "claude",
        displayName: "Claude",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [
        {
          type: "text",
          blockId: `seed-text-${String(turn)}`,
          status: "completed",
          timestamp: 11 + turn * 2,
          text: Array.from(
            { length: 2 + (turn % 3) },
            (_unused, paragraph) =>
              `Reply ${String(turn)}, paragraph ${String(paragraph + 1)}. ` +
              "The quick brown fox jumps over the lazy dog. ".repeat(5),
          ).join("\n\n"),
          providerNotice: null,
        },
      ],
      startedAt: 11 + turn * 2,
      timestamp: 11 + turn * 2,
      turnId: `seed-turn-${String(turn)}`,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    });
  }
  if (withEarlier) {
    out.push({
      role: "user",
      messageId: "message-earlier",
      sender: { type: "user", userId: OWNER_ID },
      message: {
        kind: "user",
        content: promptContent("An earlier prompt", false),
        browserAnnotations: [],
      },
      timestamp: 50,
      sessionAnchor: null,
    });
  }
  return out;
}

function chatRecord(withEarlier: boolean): Chat {
  return {
    id: CHAT_ID,
    parentId: null,
    userId: OWNER_ID,
    hostId: HOST_ID,
    title: "Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    settings: null,
    activeSessionChain: null,
    claudePendingWakes: [],
    messages: seededMessages(withEarlier),
    events: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
}

function open(kind: ScenarioKind): void {
  const busy = kind === "activating" || kind === "running";
  let activeTurn: ChatActiveTurn | null = null;
  if (kind === "activating") activeTurn = earlierTurn("starting");
  if (kind === "running") activeTurn = earlierTurn("running");
  const cb = liveCallbacks();
  cb.onConnectionStatus("open", null, null);
  cb.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: chatRecord(busy),
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: kind === "idle" ? "idle" : "running",
      turnInProgress: busy,
      sendWouldQueue: busy,
      activeTurn,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
    },
  });
}

function turnFor(messageId: string): ChatActiveTurn {
  return {
    ...earlierTurn("running"),
    turnId: "turn-send",
    userMessageId: messageId,
    startedAt: 251,
  };
}

function queuedItem(messageId: string, text: string): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: `queue-${messageId}`,
    messageId,
    message: {
      kind: "user",
      content: promptContent(text, false),
      browserAnnotations: [],
    },
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    sentFromHostId: null,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

const sentTexts = new Map<string, string>();
let lastSentMessageId: string | null = null;
let queued: ChatQueuedPromptItem[] = [];

function emitQueue(): void {
  liveCallbacks().onQueueChanged({
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    queue: { status: queued.length > 0 ? "running" : "idle", items: queued },
  });
}

function setupCreatingEvent(messageId: string): ChatEvent {
  return {
    eventId: "event-setup-creating",
    type: "setup.creating",
    timestamp: 300,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: {
      workspacePath: "/repo",
      branch: "feature",
      triggeringMessageId: messageId,
    },
  };
}

type RichEvent = Parameters<ChatStreamCallbacks["onBlockDelta"]>[0]["event"];

function richEvents(prefix: string, cycles: number): RichEvent[] {
  const out: RichEvent[] = [];
  let ts = 1000;
  for (let c = 0; c < cycles; c += 1) {
    const reasoning = `${prefix}-r${String(c)}`;
    const text = `${prefix}-t${String(c)}`;
    const tool = `${prefix}-tool${String(c)}`;
    for (let i = 0; i < 6; i += 1) {
      ts += 1;
      out.push({
        type: "reasoning.delta",
        blockId: reasoning,
        timestamp: ts,
        delta: `Thinking step ${String(i)} about the problem in detail. `,
      });
    }
    ts += 1;
    out.push({
      type: "reasoning.completed",
      blockId: reasoning,
      timestamp: ts,
    });
    for (let i = 0; i < 30; i += 1) {
      ts += 1;
      out.push({
        type: "text.delta",
        blockId: text,
        timestamp: ts,
        delta:
          i % 10 === 9
            ? " end of paragraph.\n\nNext paragraph"
            : ` word${String(i)}`,
      });
    }
    ts += 1;
    out.push({ type: "text.completed", blockId: text, timestamp: ts });
    ts += 1;
    out.push({
      type: "tool_call.started",
      blockId: tool,
      timestamp: ts,
      toolName: "Bash",
      input: { command: `ls -la dir-${String(c)}` },
      agentMessageSend: null,
    });
    ts += 1;
    out.push({
      type: "tool_call.completed",
      blockId: tool,
      timestamp: ts,
      toolName: "Bash",
      agentMessageSend: null,
      imageResults: [],
    });
  }
  return out;
}

let replyTimer: number | null = null;
function stopReply(): void {
  if (replyTimer === null) return;
  window.clearInterval(replyTimer);
  window.clearTimeout(replyTimer);
  replyTimer = null;
}

function scrollNode(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="chat-messages-scroll"]',
  );
}

function promptBounds(node: HTMLElement): {
  top: number | null;
  bottom: number | null;
} {
  const nodeRect = node.getBoundingClientRect();
  let top: number | null = null;
  let bottom: number | null = null;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const content = text.textContent ?? "";
    const rect = text.parentElement?.getBoundingClientRect();
    if (rect === undefined) continue;
    if (content.includes("PROBE-PROMPT")) top = rect.top - nodeRect.top;
    if (content.includes("PROBE-END")) bottom = rect.bottom - nodeRect.top;
  }
  return { top, bottom };
}

function readGeometry(
  node: HTMLElement | null,
): Pick<
  ScrollProbe,
  "scrollTop" | "scrollHeight" | "clientHeight" | "distance" | "mode"
> {
  if (node === null) {
    return {
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      distance: 0,
      mode: null,
    };
  }
  return {
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    distance: node.scrollHeight - node.clientHeight - node.scrollTop,
    mode: node.dataset.scrollMode ?? null,
  };
}

function readProbe(): ScrollProbe {
  const node = scrollNode();
  const bounds =
    node === null ? { top: null, bottom: null } : promptBounds(node);
  const pill = document.querySelector('[aria-label="Scroll to end"]');
  const dock = document.querySelector("[data-chat-lower-surfaces-overlay]");
  const rowEls = Array.from(
    node?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [],
  );
  return {
    ...readGeometry(node),
    pill: pill !== null && pill.getAttribute("aria-hidden") !== "true",
    dockHeight: dock?.getBoundingClientRect().height ?? 0,
    promptTop: bounds.top,
    promptBottom: bounds.bottom,
    rows: rowEls.length,
    lastRowKey: rowEls.at(-1)?.dataset.messageId ?? null,
  };
}

const driver: SendDriver = {
  probe: readProbe,
  ready: false,
  lastMessageId: () => lastSentMessageId,
  open,
  send: (text, options) => {
    const sent = handle.store.getState().sendMessage({
      content: promptContent(text, options.image),
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      attachments: [],
      deliveryPolicy: "auto",
      restore: {
        content: promptContent(text, options.image),
        browserAnnotations: [],
      },
    });
    if (sent === null) throw new Error("the send was refused");
    sentTexts.set(sent.messageId, text);
    return sent.messageId;
  },
  host: {
    accept: (messageId) => {
      liveCallbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: {
          role: "user",
          messageId,
          sender: { type: "user", userId: OWNER_ID },
          message: {
            kind: "user",
            content: promptContent(sentTexts.get(messageId) ?? "", false),
            browserAnnotations: [],
          },
          timestamp: 250,
          sessionAnchor: null,
        },
      });
    },
    turnStarted: (messageId) => {
      liveCallbacks().onTurnStateChanged({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        runStatus: "running",
        activeTurn: turnFor(messageId),
        turnInProgress: true,
        sendWouldQueue: false,
      });
    },
    queueAdded: (messageId) => {
      queued = [
        ...queued,
        queuedItem(messageId, sentTexts.get(messageId) ?? ""),
      ];
      emitQueue();
    },
    queueRemoved: () => {
      queued = [];
      emitQueue();
    },
    earlierTurnEnded: () => {
      liveCallbacks().onTurnStateChanged({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        runStatus: "running",
        activeTurn: null,
        turnInProgress: false,
        sendWouldQueue: false,
      });
    },
    streamReply: (tokens, intervalMs) => {
      stopReply();
      let sent = 0;
      replyTimer = window.setInterval(() => {
        if (sent >= tokens) {
          stopReply();
          return;
        }
        const delta =
          sent % 24 === 23
            ? " end of paragraph.\n\nNext paragraph"
            : ` word${String(sent)}`;
        sent += 1;
        liveCallbacks().onBlockDelta({
          kind: "blockDelta",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: CHAT_ID,
          event: {
            type: "text.delta",
            blockId: "reply-text",
            timestamp: 300 + sent,
            delta,
          },
        });
      }, intervalMs);
    },
    stopReply,
    streamParts: (parts) => {
      stopReply();
      const queue: { delay: number; event: RichEvent }[] = [];
      let ts = 9000;
      for (let k = 0; k < parts; k += 1) {
        const tokens = 4 + (k % 3);
        for (let i = 0; i < tokens; i += 1) {
          ts += 1;
          queue.push({
            delay: i % 5 === 4 ? 80 + ((k * 37) % 71) : 30 + ((i * 13) % 31),
            event: {
              type: "text.delta",
              blockId: `parts-t${String(k)}`,
              timestamp: ts,
              delta:
                i === tokens - 1 ? " end of block.\n\n" : ` word${String(i)}`,
            },
          });
        }
        ts += 1;
        queue.push({
          delay: 40,
          event: {
            type: "tool_call.started",
            blockId: `parts-tool${String(k)}`,
            timestamp: ts,
            toolName: "Bash",
            input: { command: `ls part-${String(k)}` },
            agentMessageSend: null,
          },
        });
        ts += 1;
        queue.push({
          delay: 40,
          event: {
            type: "tool_call.completed",
            blockId: `parts-tool${String(k)}`,
            timestamp: ts,
            toolName: "Bash",
            agentMessageSend: null,
            imageResults: [],
          },
        });
      }
      let at = 0;
      const step = (): void => {
        if (at >= queue.length) {
          replyTimer = null;
          return;
        }
        const item = queue[at];
        at += 1;
        liveCallbacks().onBlockDelta({
          kind: "blockDelta",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: CHAT_ID,
          event: item.event,
        });
        replyTimer = window.setTimeout(step, item.delay);
      };
      step();
    },
    streamBursty: (tokens, blockId) => {
      stopReply();
      let sent = 0;
      const step = (): void => {
        if (sent >= tokens) {
          replyTimer = null;
          return;
        }
        const delta =
          sent % 12 === 11
            ? " end of paragraph.\n\nNext paragraph"
            : ` word${String(sent)}`;
        const gap =
          sent % 9 === 8 ? 80 + ((sent * 37) % 71) : 30 + ((sent * 13) % 31);
        sent += 1;
        liveCallbacks().onBlockDelta({
          kind: "blockDelta",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: CHAT_ID,
          event: {
            type: "text.delta",
            blockId,
            timestamp: 5000 + sent,
            delta,
          },
        });
        replyTimer = window.setTimeout(step, gap);
      };
      step();
    },
    streamRich: (prefix, cycles, intervalMs) => {
      stopReply();
      const events = richEvents(prefix, cycles);
      let index = 0;
      replyTimer = window.setInterval(() => {
        if (index >= events.length) {
          stopReply();
          return;
        }
        const event = events[index];
        index += 1;
        liveCallbacks().onBlockDelta({
          kind: "blockDelta",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: CHAT_ID,
          event,
        });
      }, intervalMs);
    },
    setupCreating: (messageId) => {
      liveCallbacks().onEventAppended({
        kind: "eventAppended",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: setupCreatingEvent(messageId),
      });
    },
  },
};
probeWindow.__followDriver = driver;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

/**
 * What the tile's `dispatchUserSend` does once the composer has built its
 * submit input: put it in the store as the person's own send.
 */
function submitFromComposer(input: ChatComposerSubmitInput): boolean {
  const sent = handle.store.getState().sendMessage({
    content: input.content,
    sender: { type: "user", userId: OWNER_ID },
    settings: input.settings,
    attachments: input.attachments,
    deliveryPolicy: input.deliveryPolicy,
    restore: input.restore,
  });
  if (sent === null) return false;
  sentTexts.set(sent.messageId, input.contentText);
  lastSentMessageId = sent.messageId;
  return true;
}

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});
let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `chat-send-follow-${String(++requestCounter)}`,
    handlers: {},
  });

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

/** The epic the composer reads its title and attachments from. */
const EPIC_SESSION = openStoreForTest({
  epicId: EPIC_ID,
  userId: null,
  factories: {
    streamClientFactory: noopEpicStreamClientFactory,
    laneSelection: null,
  },
  writeCommand: null,
});
getOpenEpicRegistry().acquire(EPIC_ID, () => EPIC_SESSION);

const NO_BACKGROUND_STOPS = SAMPLE_NO_PENDING_STOPS;
const RESTORE: ChatRestoreContextValue = {
  ...SAMPLE_RESTORE,
  activeHostId: HOST_ID,
  accumulatedFileChanges: [],
};
const EMPTY_SET: ReadonlySet<string> = new Set();

export function Fixture(): ReactElement {
  const state = useStore(handle.store);
  const drillIn = useSubagentDrillIn(state.snapshotLoaded);
  const [scroll] =
    useState<ChatSessionMessagesSurfaceProps["scrollRequest"]>(null);
  const turnStatus = composerTurnStatus(state.runStatus);
  const composerStatus = resolvedTurnStatus(state, turnStatus);
  // The working row never rides the queue-drain continuity, only the composer.
  const workingRowStatus = resolvedTurnStatus(
    { ...state, queueTurnContinuity: false },
    turnStatus,
  );
  const queue = queueWithoutPersistedPrompts(
    projectQueueWithPendingCancellations(
      queueWithDrainingPrompts(state),
      state.pendingActions,
      state.acceptedActions,
    ),
    state.messages,
  );
  const queuedPromptIds = queuedPromptMessageIds(state.queue.items);
  const rendered = useRenderedMessages(
    {
      messages: state.messages,
      events: state.events,
      rowContext: state.transcriptRowContext,
      setupCardWindows: state.transcriptDerived?.setupCardWindows ?? [],
      pendingUserMessages: state.pendingUserMessages,
      pendingTurn: state.pendingTurn,
      turnObservedAt: state.turnObservedAt,
      queuedPromptMessageIds: queuedPromptIds,
      withdrawnMessageId: null,
      liveAssistantMessage: state.liveAssistantMessage,
      activeTurn: state.activeTurn,
      pendingApprovals: state.pendingApprovals,
      pendingFileEditApprovals: state.pendingFileEditApprovals,
      pendingInterviews: state.pendingInterviews,
      runStatus: workingRowStatus ?? "idle",
      chatWorking: state.runStatus !== "idle",
      epicId: EPIC_ID,
      ownerId: CHAT_ID,
      ownerKind: "chat",
      viewTabId: "view-tab",
    },
    {
      resolveUserSenderLabel: () => "You",
      resolveUserSenderAvatarUrl: () => null,
      resolveAgentSenderDisplay: () => ({
        senderLabel: "Claude",
        providerLabel: "Claude Code",
        modelLabel: "Sonnet",
      }),
      resolveAgentReasoningLabel: () => null,
      resolveAgentServiceTierLabel: () => null,
      contentBlocksPreview: () => "",
    },
  );
  const {
    setElement: setDockElement,
    element: dockElement,
    height: dockHeight,
  } = useMeasuredElementHeight();
  const chrome = useChatDockChrome({
    snapshotLoaded: state.snapshotLoaded,
    chatId: CHAT_ID,
    restore: RESTORE,
    selfAgent: null,
    activeAgents: [],
    activeAgentsVisible: false,
    backgroundVisible: false,
    backgroundItems: [],
    runningManagedCommands: [],
    heldManagedCommands: [],
    backgroundFailureToken: null,
    portForwardCount: 0,
    queue,
    todo: null,
  });
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas text-foreground">
      <div data-testid="probe-run-state" className="sr-only">
        {composerStatus ?? "none"}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatSessionMessagesSurface
          snapshotLoaded={state.snapshotLoaded}
          thinkingTokensSource={handle.store}
          connectionStatus="open"
          fatalClose={null}
          preSnapshotRetries={null}
          preSnapshotReloadStartedAt={null}
          onRetry={sampleNoop}
          preContent={null}
          restoreContext={RESTORE}
          node={{ id: CHAT_ID, instanceId: "probe-instance", name: "Chat" }}
          taskTitle="Chat"
          epicId={EPIC_ID}
          viewTabId="view-tab"
          tabHostId={HOST_ID}
          workspaceRoots={[]}
          messages={rendered}
          activeTurnId={state.activeTurn?.turnId ?? null}
          transcriptWindow={null}
          onVisibleOrdinalRangeChange={sampleNoop}
          onFindReadOrdinalChange={sampleNoop}
          baselineEpoch={state.transcriptBaselineEpoch}
          hydrationSequence={state.transcriptHydrationSequence}
          coldRewrittenMessageIds={EMPTY_SET}
          backgroundItems={state.backgroundItems}
          scrollRequest={scroll}
          onScrollRequestSettled={sampleNoop}
          surfaceVisible
          systemOverlayActive={false}
          getMessageActions={() => null}
          nextStepActions={{ canSend: false, onSend: () => false }}
          planActions={{
            epicId: EPIC_ID,
            chatId: CHAT_ID,
            canSend: false,
            pending: false,
            onImplement: () => false,
          }}
          composerOverlayHeight={dockElement === null ? 0 : dockHeight}
          subagentDrillIn={drillIn}
        />
      </div>
      <div
        ref={setDockElement}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10"
        data-chat-lower-surfaces-overlay=""
      >
        <TabHostContext.Provider value={HOST_ID}>
          <ChatDiffTargetContext.Provider value={null}>
            <ChatDockCompactStripProvider value={chrome.strip}>
              <ChatLowerDock
                snapshotLoaded={state.snapshotLoaded}
                epicId={EPIC_ID}
                chatId={CHAT_ID}
                viewTabId="view-tab"
                selfAgent={null}
                activeAgents={[]}
                todo={null}
                restore={RESTORE}
                queue={queue}
                folded={chrome.folded}
                dockOrder={chrome.dockOrder}
                hotspots={chrome.hotspots}
                backgroundItems={[]}
                runningManagedCommandCount={0}
                heldManagedCommandCount={0}
                portForwardCount={0}
                backgroundStopPendingTaskIds={NO_BACKGROUND_STOPS}
                backgroundStopAllPending={false}
                backgroundSessionStopPending={false}
                activeTurnStatus={composerStatus}
                canAct
                queueResumeRequested={false}
                queueKeepPausedRequested={false}
                readOnly={false}
                editingQueueItemId={null}
                topSpacing="normal"
                scrollRegionMaxHeightClass="max-h-[min(24dvh,12rem)]"
                onQueuePause={() => null}
                onQueueResume={() => null}
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
              <ChatComposer
                taskId={CHAT_ID}
                isActive
                sendDisabled={false}
                sendDisabledHint={null}
                mentionRoots={[]}
                fallbackToGlobalMentionRoots={false}
                currentEpicId={EPIC_ID}
                viewTabId="view-tab"
                settingsSeed={SETTINGS}
                fallbackSettingsSeed={SETTINGS}
                providerFallback={NO_PROVIDER_FALLBACK}
                onSubmitMessage={submitFromComposer}
                onSideChat={null}
                onSettingsChange={null}
                activeTurnStatus={composerStatus}
                steerCapable={false}
                steerProtocolSupported={false}
                autoPermissionModeProtocolSupported={null}
                ultracodeProtocolSupported={false}
                getDraftBlobBridgeSupported={() => false}
                getActiveTurnForSteer={() => null}
                editingQueueItemId={null}
                onCancelQueueEdit={null}
                hasPendingApprovals={false}
                stopDisabled={false}
                onStopTurn={() => {
                  handle.store.getState().stopTurn();
                }}
                workspaceControls={null}
                workspaceAvailability={{ status: "ready", disabledHint: null }}
                topSpacing="normal"
                topSlot={null}
                suggestedPrompt={undefined}
                restingSandbox={null}
              />
            </ChatDockCompactStripProvider>
          </ChatDiffTargetContext.Provider>
        </TabHostContext.Provider>
      </div>
    </div>
  );
}

driver.ready = true;
const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
const rootRoute = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-fixture-runtime-fallback />}
        >
          <LazyMotion features={domAnimation}>
            <TooltipProvider>
              <EpicSessionContext value={EPIC_SESSION}>
                <TabHostContext.Provider value={HOST_ID}>
                  <Fixture />
                </TabHostContext.Provider>
              </EpicSessionContext>
            </TooltipProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  ),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(container).render(<RouterProvider router={router} />);
