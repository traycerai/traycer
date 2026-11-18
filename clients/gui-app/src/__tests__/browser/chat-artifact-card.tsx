import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  EpicReadArtifactObjectRequest,
  EpicReadArtifactObjectResponse,
} from "@traycer/protocol/host/epic/artifact-objects";
import type {
  ReadChatAttachmentRequest,
  ReadChatAttachmentResponse,
} from "@traycer/protocol/host/epic/chat-attachment";
import type { ArtifactHead } from "@traycer/protocol/persistence/epic/artifacts";
import type { EpicEditArtboardRequest } from "@traycer/protocol/host/epic/artboard-edit";
import type { HtmlArtifactVersion } from "@traycer/protocol/host/epic/html-artifact-versions";
import type { ToolCallArtifactStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import type {
  CommentThreadWire,
  CreateCommentThreadRequest,
  ListCommentThreadsRequest,
} from "@traycer/protocol/host/epic/unary-schemas";
import { insertTid } from "@traycer/html-source";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  SandboxArtifactBridge,
  SandboxArtifactCancel,
  SandboxArtifactOriginParts,
  SandboxArtifactReply,
  SandboxArtifactRequest,
} from "@traycer-clients/shared/platform/sandbox-artifacts";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import { fetchRemoteHosts } from "@traycer-clients/shared/host-client/remote-fetcher";
import { ChatMessages } from "@/components/chat/chat-messages";
import {
  ChatAttachmentScopeContext,
  type ChatAttachmentReadClient,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import { TileMinimapScope } from "@/components/epic-canvas/tile-minimap/tile-minimap-scope";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";
import { holdFullscreenBlocker } from "@/lib/sandbox/overlay-owner";
import { parseArtifactAddress } from "@/lib/sandbox/artifact-serving/artifact-address";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { ChatMessage } from "@/stores/composer/chat-store";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { setInstanceLive } from "./chat-scroll-model-support";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * Two artifact cards in the real virtualized transcript (`ChatMessages` over
 * LegendList): card A near the top, card B a little below it, a long chat of
 * filler turns around them. Each card is a tool call carrying a
 * `ToolCallArtifactStamp`, so `ArtifactRow` renders it exactly as a task chat
 * does, over a fake host that serves each page's bytes, its comment threads,
 * its version history and the edit that stamps a comment id.
 *
 * `window.__chatCardProbe` is the spec's handle: it serves the pages, gives an
 * artifact a new head (a save), holds the blocker a pending approval holds,
 * and makes the next create fail. Counters live on `body` data attributes.
 */
const EPIC_ID = "chat-card-epic";
const CHAT_ID = "chat-card-chat";
const VIEW_TAB_ID = "chat-card-view";
const HOST_ID = "chat-card-host";
const ENTRY_PATH = "index.html";
const TURNS = 40;
const CARD_A_MESSAGE = 3;
const CARD_B_MESSAGE = 7;

interface CardSpec {
  readonly id: string;
  readonly title: string;
  readonly messageIndex: number;
  readonly sha: string;
}

const CARDS: readonly CardSpec[] = [
  {
    id: "report-a",
    title: "Report A",
    messageIndex: CARD_A_MESSAGE,
    sha: "a".repeat(64),
  },
  {
    id: "report-b",
    title: "Report B",
    messageIndex: CARD_B_MESSAGE,
    sha: "b".repeat(64),
  },
];

const CAPTURED_AT = 1_000;

function pageHtml(title: string, version: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0}
body{font:16px/1.4 sans-serif;padding:8px 16px}
#known,#plain{display:block;margin:0 0 8px;padding:12px 16px;background:#e8eef8}
#plain{background:#f4f0e6}
</style></head><body><h2 id="known" data-tid="known">${title} version ${String(version)}</h2><p id="plain">A paragraph with no comment id yet.</p></body></html>`;
}

const bytesBySha = new Map<string, Uint8Array>();
function storeBytes(sha: string, html: string): Uint8Array {
  const bytes = new TextEncoder().encode(html);
  bytesBySha.set(sha, bytes);
  return bytes;
}

function manifestOf(sha: string, byteLength: number): ArtifactHead {
  return {
    files: {
      [ENTRY_PATH]: {
        sha256: sha,
        byteLength,
        mediaType: "text/html",
        status: "local-only",
      },
    },
    capturedAt: CAPTURED_AT,
  };
}

function projectionOf(card: CardSpec, bytes: Uint8Array): ArtifactProjection {
  return {
    id: card.id,
    kind: "html",
    title: card.title,
    layout: "folder",
    folderName: card.id,
    parentId: null,
    artifactRoomId: `${card.id}-room`,
    createdAt: 0,
    updatedAt: 0,
    status: null,
    createdManually: false,
    head: manifestOf(card.sha, bytes.length),
  };
}

function historyEntry(
  sha: string,
  byteLength: number,
  versionNumber: number,
  capturedAt: number,
): HtmlArtifactVersion {
  return {
    id: sha,
    versionNumber,
    entryPath: ENTRY_PATH,
    manifest: {
      files: {
        [ENTRY_PATH]: {
          sha256: sha,
          byteLength,
          mediaType: "text/html",
        },
      },
      capturedAt,
    },
  };
}

const historyById = new Map<string, HtmlArtifactVersion[]>();
const stamps: ToolCallArtifactStamp[] = [];
const projections: Record<string, ArtifactProjection> = {};
for (const card of CARDS) {
  const bytes = storeBytes(card.sha, pageHtml(card.title, 1));
  projections[card.id] = projectionOf(card, bytes);
  historyById.set(card.id, [
    historyEntry(card.sha, bytes.length, 1, CAPTURED_AT),
  ]);
  stamps.push({
    artifactId: card.id,
    title: card.title,
    manifest: {
      files: {
        [ENTRY_PATH]: {
          sha256: card.sha,
          byteLength: bytes.length,
          mediaType: "text/html",
        },
      },
      capturedAt: CAPTURED_AT,
    },
    originChatId: CHAT_ID,
  });
}

useAuthStore
  .getState()
  .setSignedIn(
    { userId: "user-1", userName: "U", email: "u@example.invalid" },
    { userId: "user-1", username: "U" },
    [],
  );
const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});
const epicHandle = openStoreForTest({
  epicId: EPIC_ID,
  userId: "user-1",
  factories: {
    streamClientFactory: noopEpicStreamClientFactory,
    laneSelection: null,
  },
  writeCommand: null,
});
const threadsByArtifact: Record<string, CommentThreadWire[]> = {};
function publishThreads(): void {
  epicHandle.store.setState({
    commentThreads: { byArtifactId: { ...threadsByArtifact } },
  });
}
for (const card of CARDS) threadsByArtifact[card.id] = [];
epicHandle.store.setState({
  durabilityStatus: "local",
  recordsTransportStatus: "open",
  artifacts: {
    byId: { ...projections },
    allIds: CARDS.map((card) => card.id),
  },
  commentThreads: { byArtifactId: { ...threadsByArtifact } },
});
recordNegotiatedHostManifest(HOST_ID, {
  "epic.createCommentThread": { major: 1, minor: 3 },
  "epic.listHtmlArtifactVersions": { major: 1, minor: 0 },
});

function bump(name: "edits" | "creates"): void {
  const body = document.body;
  body.dataset[name] = String(Number(body.dataset[name] ?? "0") + 1);
}

let headCounter = 1;
let failCreateOnce = false;
let createdCount = 0;
let stampCount = 0;

/** The artifact's head moves to `sha`, a new version in its history. */
function moveHead(card: CardSpec, sha: string, bytes: Uint8Array): void {
  headCounter += 1;
  const capturedAt = CAPTURED_AT + headCounter;
  const history = historyById.get(card.id) ?? [];
  historyById.set(card.id, [
    historyEntry(sha, bytes.length, history.length + 1, capturedAt),
    ...history,
  ]);
  projections[card.id] = {
    ...projections[card.id],
    head: { ...manifestOf(sha, bytes.length), capturedAt },
  };
  epicHandle.store.setState({
    artifacts: {
      byId: { ...projections },
      allIds: CARDS.map((candidate) => candidate.id),
    },
  });
}

function cardOf(artifactId: string): CardSpec {
  const card = CARDS.find((candidate) => candidate.id === artifactId);
  if (card === undefined) throw new Error(`unknown artifact ${artifactId}`);
  return card;
}

function advanceHead(artifactId: string): void {
  const card = cardOf(artifactId);
  const sha = (headCounter + 1).toString(16).padStart(64, "c");
  moveHead(card, sha, storeBytes(sha, pageHtml(card.title, headCounter + 1)));
}

let releaseBlocker: (() => void) | null = null;

interface ServedFile {
  readonly status: number;
  readonly mediaType: string;
  readonly base64: string;
}

interface ChatCardProbe {
  readonly serve: (url: string) => Promise<ServedFile>;
  /** A save: the artifact's head moves to a new manifest and version. */
  readonly advanceHead: (artifactId: string) => void;
  /** What a pending approval holds: fullscreen blocked, any raise yielded. */
  readonly holdBlocker: () => void;
  readonly releaseBlocker: () => void;
  /** The next `epic.createCommentThread` rejects, once. */
  readonly failNextCreate: () => void;
}
declare global {
  interface Window {
    __chatCardProbe?: ChatCardProbe;
  }
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const SPAN_BYTES = 4 * 1024 * 1024;

class FixtureArtifactBridge implements SandboxArtifactBridge {
  readonly policySource = null;
  private readonly handlers = new Set<
    (request: SandboxArtifactRequest) => void
  >();
  private readonly replies = new Map<
    string,
    (reply: SandboxArtifactReply) => void
  >();
  private requestCounter = 0;

  artifactOrigin({ artifactId, mountId }: SandboxArtifactOriginParts): string {
    return `https://artifact-${artifactId}--${mountId}.traycer-artifact.invalid`;
  }
  register(): Promise<void> {
    return Promise.resolve();
  }
  unregister(): Promise<void> {
    return Promise.resolve();
  }
  onRequest(handler: (request: SandboxArtifactRequest) => void): Disposable {
    this.handlers.add(handler);
    return { dispose: () => this.handlers.delete(handler) };
  }
  onCancel(_handler: (cancel: SandboxArtifactCancel) => void): Disposable {
    return { dispose: () => undefined };
  }
  respond(reply: SandboxArtifactReply): Promise<void> {
    this.replies.get(reply.requestId)?.(reply);
    this.replies.delete(reply.requestId);
    return Promise.resolve();
  }

  private ask(mountId: string, path: string, offset: number) {
    const requestId = `chat-card-${String((this.requestCounter += 1))}`;
    return new Promise<SandboxArtifactReply>((resolve) => {
      this.replies.set(requestId, resolve);
      for (const handler of this.handlers)
        handler({ requestId, mountId, path, offset, length: SPAN_BYTES });
    });
  }

  async serve(url: string): Promise<ServedFile> {
    const address = parseArtifactAddress(url);
    if (address === null)
      return { status: 404, mediaType: "text/plain", base64: "" };
    const chunks: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const reply = await this.ask(address.mountId, address.path, offset);
      if (reply.kind === "unavailable")
        return { status: reply.status, mediaType: "text/plain", base64: "" };
      chunks.push(reply.bytes);
      offset += reply.bytes.length;
      if (offset >= reply.totalBytes || reply.bytes.length === 0) {
        const whole = new Uint8Array(offset);
        let at = 0;
        for (const chunk of chunks) {
          whole.set(chunk, at);
          at += chunk.length;
        }
        return {
          status: 200,
          mediaType: reply.mediaType,
          base64: base64Of(whole),
        };
      }
    }
  }
}
const artifactBridge = new FixtureArtifactBridge();

window.__chatCardProbe = {
  serve: (url) => artifactBridge.serve(url),
  advanceHead,
  holdBlocker: () => {
    releaseBlocker?.();
    releaseBlocker = holdFullscreenBlocker();
  },
  releaseBlocker: () => {
    releaseBlocker?.();
    releaseBlocker = null;
  },
  failNextCreate: () => {
    failCreateOnce = true;
  },
};

/** The card's own byte reads, which the page's frame is served from. */
function readObject(
  request: EpicReadArtifactObjectRequest,
): EpicReadArtifactObjectResponse {
  const bytes = bytesBySha.get(request.sha256);
  if (bytes === undefined) return { kind: "unavailable", reason: "missing" };
  if (request.want.kind === "text") {
    return {
      kind: "text",
      text: new TextDecoder().decode(bytes),
      mediaType: "text/html",
      networkPolicy: "https-only",
    };
  }
  if (request.want.kind !== "range")
    throw new Error("this fixture serves text and ranges only");
  const { offset, length } = request.want;
  return {
    kind: "bytes",
    bytesBase64: base64Of(bytes.slice(offset, offset + length)),
    offset,
    totalBytes: bytes.length,
    mediaType: "text/html",
  };
}

function requestWithSignal(
  method: "epic.readArtifactObject",
  params: EpicReadArtifactObjectRequest,
  signal: AbortSignal | undefined,
): Promise<EpicReadArtifactObjectResponse>;
function requestWithSignal(
  method: "epic.readChatAttachment",
  params: ReadChatAttachmentRequest,
  signal: AbortSignal | undefined,
): Promise<ReadChatAttachmentResponse>;
function requestWithSignal(
  method: "epic.readArtifactObject" | "epic.readChatAttachment",
  params: EpicReadArtifactObjectRequest | ReadChatAttachmentRequest,
): Promise<EpicReadArtifactObjectResponse | ReadChatAttachmentResponse> {
  if (method === "epic.readArtifactObject" && "sha256" in params)
    return Promise.resolve(readObject(params));
  return Promise.reject(new Error(`Unexpected read: ${method}`));
}

const readClient: ChatAttachmentReadClient = {
  requestWithSignal,
  requestWithSignalRequiringHostMethodVersion() {
    return Promise.reject(new Error("Unexpected attachment read"));
  },
};

const scope: ChatAttachmentScopeValue = {
  epicId: EPIC_ID,
  chatId: CHAT_ID,
  hostId: HOST_ID,
  hostVersion: null,
  client: readClient,
};

const queryClient = createAppQueryClient();
const mockRunnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: {
    hostId: HOST_ID,
    websocketUrl: "ws://127.0.0.1:9/chat-card",
    version: "0.0.0-fixture",
    pid: 1,
    systemHostName: "fixture",
    displayName: "fixture",
    availability: "available",
  },
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});
// A browser has no native artifact scheme: the mock declares `sandboxArtifacts`
// as null, so the frame would show the desktop-only placeholder.
const runnerHost: IRunnerHost = Object.assign(
  Object.create(MockRunnerHost.prototype) as IRunnerHost,
  mockRunnerHost,
  { sandboxArtifacts: artifactBridge },
);
let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `chat-card-${String((requestCounter += 1))}`,
    handlers: {
      "host.status": () => ({
        ready: true,
        hostVersion: "1.2.3",
        protocolVersion: { major: 1, minor: 2 },
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
        busyBreakdown: null,
        updateOperation: null,
        updateTransaction: null,
        storeFormats: null,
        install: null,
        processMemory: null,
        crossHostMessaging: null,
        sessions: null,
        updatesExternallyManaged: null,
        previousExit: null,
      }),
      "host.notifications.indicatorState": () => ({
        epics: {},
        chats: {},
        complete: true,
      }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
      "epic.listHtmlArtifactVersions": (request: {
        readonly artifactId: string;
      }) => {
        const versions = historyById.get(request.artifactId) ?? [];
        return {
          versions,
          nextCursor: null,
          currentVersionNumber: versions.at(0)?.versionNumber ?? null,
        };
      },
      "epic.readArtifactObject": readObject,
      "epic.listCommentThreads": (request: ListCommentThreadsRequest) => ({
        threads: threadsByArtifact[request.artifactId] ?? [],
      }),
      "epic.editArtboard": (request: EpicEditArtboardRequest) => {
        if (request.edit.kind !== "insert-tid-only") {
          return {
            ok: false as const,
            reason: "unsupported",
            detail: "This fixture only stamps a comment id.",
          };
        }
        const current = bytesBySha.get(request.servedSha256);
        if (current === undefined) {
          return {
            ok: false as const,
            reason: "missing",
            detail: "The page being commented on is not served.",
          };
        }
        stampCount += 1;
        bump("edits");
        const tid = `comment-${String(stampCount)}`;
        const edited = insertTid(
          new TextDecoder().decode(current),
          request.locator,
          tid,
        );
        if (!edited.ok) {
          return {
            ok: false as const,
            reason: edited.reason,
            detail: "The comment id could not be written into the page.",
          };
        }
        const sha256After = stampCount.toString(16).padStart(64, "e");
        const stamped = new TextEncoder().encode(edited.text);
        bytesBySha.set(sha256After, stamped);
        // The host's write moves the artifact's head to the stamped page.
        moveHead(cardOf(request.artifactId), sha256After, stamped);
        return {
          ok: true as const,
          tid,
          sha256After,
          splices: edited.splices,
        };
      },
      "epic.createCommentThread": (request: CreateCommentThreadRequest) => {
        if (failCreateOnce) {
          failCreateOnce = false;
          throw new Error("The comment could not be saved.");
        }
        bump("creates");
        createdCount += 1;
        const threadId = `thread-posted-${String(createdCount)}`;
        const anchor = request.anchor;
        if (anchor !== undefined && anchor.kind === "element") {
          const thread: CommentThreadWire = {
            threadId,
            resolved: false,
            createdAt: 10 + createdCount,
            comments: [
              {
                commentId: `${threadId}-c1`,
                content: request.content,
                createdAt: 10 + createdCount,
                updatedAt: null,
                author: { userId: "user-1", fallbackHandle: "You" },
              },
            ],
            data: {
              createdByUserId: "user-1",
              anchorKind: "element",
              artboard: anchor.artboard,
              elementId: anchor.elementId,
              label: anchor.label,
            },
          };
          threadsByArtifact[request.artifactId] = [
            ...(threadsByArtifact[request.artifactId] ?? []),
            thread,
          ];
          publishThreads();
        }
        return { threadId };
      },
    },
  });

/** Holds the page back until the host client has its request context. */
function RequestContext(props: { readonly children: ReactNode }): ReactNode {
  const binding = useHostBinding();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || binding === null) return;
    const unsubscribe = binding.hostClient.onChange(() => setReady(true));
    binding.hostClient.setRequestContext(
      createRendererContextFixture({ bearerToken: "fixture" }),
    );
    return unsubscribe;
  }, [binding, ready]);
  return ready && binding !== null ? (
    <EpicSessionHostClientContext value={binding.hostClient}>
      {props.children}
    </EpicSessionHostClientContext>
  ) : null;
}

function fillerMessage(index: number): ChatMessage {
  const id = `message-${index}`;
  if (index % 2 === 0) {
    return {
      ...makeMessage(index, "user"),
      content: `Question ${String(index / 2)}: what about this?`,
      persistentMessageId: id,
    };
  }
  return {
    ...makeMessage(index, "assistant"),
    segments: [
      {
        id: `${id}:text`,
        kind: "text" as const,
        markdown: Array.from(
          { length: 3 },
          (_unused, paragraph) =>
            `Reply ${String(index)}, paragraph ${String(paragraph + 1)}. ` +
            "The quick brown fox jumps over the lazy dog. ".repeat(6),
        ).join("\n\n"),
        isStreaming: false,
      },
    ],
    completedAt: index,
    persistentMessageId: id,
  };
}

function cardMessage(index: number, stamp: ToolCallArtifactStamp): ChatMessage {
  const id = `message-${String(index)}`;
  return {
    ...makeMessage(index, "assistant"),
    segments: [
      {
        id: `${id}:text`,
        kind: "text" as const,
        markdown: `Here is ${stamp.title}.`,
        isStreaming: false,
      },
      {
        id: `${id}:tool`,
        kind: "tool" as const,
        toolName: "publish_artifact",
        inputSummary: null,
        inputDetail: null,
        taskTodoItems: null,
        error: null,
        agentMessageSend: null,
        managedCommand: null,
        agentMessageReceipt: null,
        agentMessageDelivery: null,
        botSendReceipt: null,
        isStreaming: false,
        endState: null,
        stopped: false,
        progress: null,
        backgroundOutput: null,
        backgroundTask: false,
        startedAt: 0,
        durationMs: null,
        parentId: null,
        imageResults: [],
        artifact: stamp,
        mcpApp: null,
        feedbackDraft: null,
      },
    ],
    completedAt: index,
    persistentMessageId: id,
  };
}

function initialMessages(): ChatMessage[] {
  return Array.from({ length: TURNS * 2 }, (_unused, index) => {
    const card = CARDS.findIndex(
      (candidate) => candidate.messageIndex === index,
    );
    const stamp = card < 0 ? undefined : stamps.at(card);
    return stamp === undefined
      ? fillerMessage(index)
      : cardMessage(index, stamp);
  });
}

const INSTANCE_ID = "chat-card-tile";

function Transcript(): ReactNode {
  const [messages] = useState<ChatMessage[]>(initialMessages);
  const subagentDrillIn = useSubagentDrillIn(true);
  useLayoutEffect(() => {
    setInstanceLive(INSTANCE_ID, true);
  }, []);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-chat-keyboard-scroll-scope=""
      data-active="true"
    >
      <TileMinimapScope tileInstanceId={INSTANCE_ID}>
        <ChatMessages
          taskTitle="Chat artifact card"
          taskId={CHAT_ID}
          epicId={EPIC_ID}
          hostId={null}
          payerHostId={null}
          messages={messages}
          transcriptWindow={null}
          onVisibleOrdinalRangeChange={() => undefined}
          onFindReadOrdinalChange={() => undefined}
          baselineEpoch={0}
          hydrationSequence={0}
          coldRewrittenMessageIds={new Set()}
          backgroundItems={undefined}
          getMessageActions={() => null}
          nextStepActions={null}
          instanceId={INSTANCE_ID}
          visible
          systemOverlayActive={false}
          scrollRequest={null}
          onScrollRequestSettled={null}
          composerOverlayHeight={0}
          subagentDrillIn={subagentDrillIn}
        />
      </TileMinimapScope>
    </div>
  );
}

export function ChatArtifactCardFixture(): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={fetchRemoteHosts}
          fallback={<div data-fixture-runtime-fallback />}
        >
          <RequestContext>
            <EpicSessionContext.Provider value={epicHandle}>
              <EpicViewTabContext.Provider value={VIEW_TAB_ID}>
                <TabHostContext.Provider value={HOST_ID}>
                  <ChatAttachmentScopeContext.Provider value={scope}>
                    <TooltipProvider>
                      <div className="flex h-full w-full flex-col">
                        <Transcript />
                        {/* Outside the transcript, as a pending approval is. */}
                        <div className="flex shrink-0 items-center gap-2 border-t p-2">
                          <button
                            type="button"
                            onClick={() => {
                              const body = document.body;
                              body.dataset.approves = String(
                                Number(body.dataset.approves ?? "0") + 1,
                              );
                            }}
                          >
                            Approve
                          </button>
                        </div>
                      </div>
                    </TooltipProvider>
                  </ChatAttachmentScopeContext.Provider>
                </TabHostContext.Provider>
              </EpicViewTabContext.Provider>
            </EpicSessionContext.Provider>
          </RequestContext>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

const container = document.getElementById("root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(<ChatArtifactCardFixture />);
