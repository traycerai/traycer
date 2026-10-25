import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import {
  applyCanvasJson,
  openCanvasLayout,
} from "@traycer/protocol/persistence/epic/canvas-layout";
import type { EpicEditArtboardRequest } from "@traycer/protocol/host/epic/artboard-edit";
import type { EpicReadArtifactObjectRequest } from "@traycer/protocol/host/epic/artifact-objects";
import type {
  CommentThreadWire,
  CreateCommentThreadRequest,
  ListCommentThreadsRequest,
} from "@traycer/protocol/host/epic/unary-schemas";
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
import { parseArtifactAddress } from "@/lib/sandbox/artifact-serving/artifact-address";
import { CommentSidebarPanel } from "@/components/comments";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { CanvasArtifactSurface } from "@/components/canvas-artifact/canvas-artifact-surface";
import { CanvasSelectionProvider } from "@/components/canvas-artifact/canvas-selection-provider";
import { CanvasArtifactFixtureProvider } from "@/components/canvas-artifact/canvas-surface-context";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * Two boards, both run live at once (`LIVE_BOARD_LIMIT` easily covers two),
 * so the browser spec can prove the claims jsdom cannot: the same iframe
 * (same running document) survives entering/leaving fullscreen and switching
 * the fullscreen board back and forth, global Play makes every board take
 * input with no per-board "is_interactive" gate, ctrl-wheel zoom changes the
 * zoom readout without moving the pane, and the fullscreen header's Fit/Fill
 * buttons change the board's measured width.
 *
 * Each board stamps a random token into a visible element the instant its
 * script runs; the token only changes across page LOADS, so comparing it
 * before and after a gesture is how a spec tells "the same live document"
 * from "reloaded".
 */
const EPIC_ID = "play-epic";
const ARTIFACT_ID = "play-artifact";
const VIEW_TAB_ID = "play-view";
const HOST_ID = "play-host";
const BOARD_A_PATH = "boards/a.html";
const BOARD_A_TITLE = "A";
const BOARD_A_SHA = "a".repeat(64);
const BOARD_B_PATH = "boards/b.html";
const BOARD_B_TITLE = "B";
const BOARD_B_SHA = "b".repeat(64);

function boardHtml(
  name: string,
  link: { readonly href: string; readonly label: string } | null,
): string {
  const anchor =
    link === null
      ? ""
      : `<a href="${link.href}" data-tid="link">${link.label}</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}body{font:20px sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100vh}</style></head><body><div><div data-tid="name">${name}</div><div data-tid="token"></div>${anchor}</div><script>document.querySelector('[data-tid="token"]').textContent = String(Math.random());</script></body></html>`;
}
// A's link carries a query so a click exercises the query-reload path
// (`canvas-bootstrap.ts`'s "navigate" handler); B's carries none, so the
// trip back never needs one.
const BOARD_A_HTML = boardHtml(BOARD_A_TITLE, {
  href: "b.html?step=2",
  label: "Go to B",
});
const BOARD_B_HTML = boardHtml(BOARD_B_TITLE, {
  href: "a.html",
  label: "Go to A",
});

interface ServedFile {
  readonly status: number;
  readonly mediaType: string;
  readonly base64: string;
}
interface PlayProbe {
  readonly ready: boolean;
  readonly serve: (url: string) => Promise<ServedFile>;
}
interface ProbeWindow extends Window {
  __playProbe?: PlayProbe;
}
const probeWindow: ProbeWindow = window;

const boardABytes = new TextEncoder().encode(BOARD_A_HTML);
const boardBBytes = new TextEncoder().encode(BOARD_B_HTML);
const BYTES_BY_SHA: ReadonlyMap<string, Uint8Array> = new Map([
  [BOARD_A_SHA, boardABytes],
  [BOARD_B_SHA, boardBBytes],
]);
const files: Record<string, ArtifactObjectRef> = {
  [BOARD_A_PATH]: {
    sha256: BOARD_A_SHA,
    byteLength: boardABytes.length,
    mediaType: "text/html",
    status: "local-only",
  },
  [BOARD_B_PATH]: {
    sha256: BOARD_B_SHA,
    byteLength: boardBBytes.length,
    mediaType: "text/html",
    status: "local-only",
  },
};
const artifact: ArtifactProjection = {
  id: ARTIFACT_ID,
  kind: "canvas",
  title: "Play",
  layout: "folder",
  folderName: "canvas-play",
  parentId: null,
  artifactRoomId: "play-room",
  createdAt: 0,
  updatedAt: 0,
  status: null,
  createdManually: false,
  head: { files, capturedAt: 0 },
};

const doc = new Y.Doc();
const awareness = new Awareness(doc);
applyCanvasJson(
  openCanvasLayout(doc, ARTIFACT_ID),
  {
    v: 1,
    title: "Play",
    pages: [{ id: "page", name: "Page" }],
    boards: {
      [BOARD_A_PATH]: {
        x: 0,
        y: 0,
        w: 640,
        h: 420,
        title: BOARD_A_TITLE,
        page: "page",
      },
      [BOARD_B_PATH]: {
        x: 900,
        y: 0,
        w: 640,
        h: 420,
        title: BOARD_B_TITLE,
        page: "page",
      },
    },
    notes: {},
    order: [BOARD_A_PATH, BOARD_B_PATH],
  },
  { baseline: null, protectedBoardPaths: [] },
);

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
function elementThread(threadId: string, artboard: string): CommentThreadWire {
  return {
    threadId,
    resolved: false,
    createdAt: 1,
    comments: [
      {
        commentId: `${threadId}-c1`,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: `about ${artboard}` }],
            },
          ],
        },
        createdAt: 1,
        updatedAt: null,
        author: { userId: "user-1", fallbackHandle: "You" },
      },
    ],
    // `data-tid="name"` on each board's own markup is the real anchor target.
    data: {
      createdByUserId: "user-1",
      anchorKind: "element",
      artboard,
      elementId: "name",
      label: "A",
    },
  };
}
const THREAD_A = elementThread("thread-a", BOARD_A_PATH);
const THREAD_B = elementThread("thread-b", BOARD_B_PATH);

// A local-homed epic needs no cloud verdict for comment reads or writes
// (`isLocalHomedEpicHandle`), and an open records lane makes its seeded
// `commentThreads` slice the authoritative source over the `epic.
// listCommentThreads` poll (`resolveArtifactCommentThreads`) - so the spec
// can seed threads the same way the real client receives them over `/stream`,
// not by answering the poll.
epicHandle.store.setState({
  durabilityStatus: "local",
  recordsTransportStatus: "open",
  artifacts: { byId: { [ARTIFACT_ID]: artifact }, allIds: [ARTIFACT_ID] },
  commentThreads: { byArtifactId: { [ARTIFACT_ID]: [THREAD_A, THREAD_B] } },
});
// `useFrameCommentsEnabled` also gates on this host having negotiated
// `epic.createCommentThread` at `@1.2` - and a canvas-point draft (a click
// on empty canvas) posts only at `@1.3`. A real handshake records it, and
// this fixture's mock messenger never does, so it is recorded directly.
recordNegotiatedHostManifest(HOST_ID, {
  "epic.createCommentThread": { major: 1, minor: 3 },
});

const queryClient = createAppQueryClient();
const SPAN_BYTES = 4 * 1024 * 1024;

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Native handlers reach the page through requests; this one is reached by `serve`. */
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
    const requestId = `play-${String((this.requestCounter += 1))}`;
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

const mockRunnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: {
    hostId: HOST_ID,
    websocketUrl: "ws://127.0.0.1:9/play",
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
// The mock declares `sandboxArtifacts` as null; a browser has no native scheme,
// so the frame would show the desktop-only placeholder instead of the board.
const runnerHost: IRunnerHost = Object.assign(
  Object.create(MockRunnerHost.prototype) as IRunnerHost,
  mockRunnerHost,
  { sandboxArtifacts: artifactBridge },
);
let requestCounter = 0;
const edits: EpicEditArtboardRequest[] = [];
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `play-${String((requestCounter += 1))}`,
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
      }),
      "host.notifications.indicatorState": () => ({ epics: {}, chats: {} }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
      // The editing panel reads a board's source by hash, as it does live.
      "epic.readArtifactObject": (request: EpicReadArtifactObjectRequest) => {
        const bytes = BYTES_BY_SHA.get(request.sha256);
        return bytes === undefined
          ? { kind: "unavailable", reason: "missing" }
          : {
              kind: "text",
              text: new TextDecoder().decode(bytes),
              mediaType: "text/html",
              networkPolicy: "https-only",
            };
      },
      "epic.editArtboard": (request: EpicEditArtboardRequest) => {
        edits.push(request);
        return {
          ok: true,
          tid: null,
          sha256After: "c".repeat(64),
          splices: [],
        };
      },
      // The open records lane is the authoritative source for the seeded
      // threads; this poll only has to answer, not agree with it.
      "epic.listCommentThreads": (_request: ListCommentThreadsRequest) => ({
        threads: [THREAD_A, THREAD_B],
      }),
      "epic.createCommentThread": (_request: CreateCommentThreadRequest) => ({
        threadId: "thread-posted",
      }),
    },
  });

probeWindow.__playProbe = {
  ready: true,
  serve: (url) => artifactBridge.serve(url),
};

/** Holds the canvas back until the host client has its request context. */
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

/**
 * The rail comments panel, as the app's left panel mounts it: a sibling of
 * the canvas tile, shown while the left-panel store has Comments selected
 * for this tab - which is exactly what a pin click writes
 * (`useActivateCommentThread`). Being outside the tile is the shipped
 * contract the specs lean on: the sidebar stays visible and usable while a
 * board is fullscreen.
 */
function RailCommentsSidebar(): ReactNode {
  const selected = useLeftPanelStore(
    (s) => s.getActivePanelId(VIEW_TAB_ID) === "comments",
  );
  if (!selected) return null;
  return (
    <aside
      aria-label="Comments sidebar"
      style={{ width: "min(340px, 30vw)", flexShrink: 0, overflow: "auto" }}
    >
      <CommentSidebarPanel epicId={EPIC_ID} activeArtifactId={ARTIFACT_ID} />
    </aside>
  );
}

export function CanvasPlayFixture(): ReactNode {
  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex" }}>
      <RailCommentsSidebar />
      <div style={{ flex: 1, minWidth: 0 }}>
        <CanvasSelectionProvider
          epicId={EPIC_ID}
          artifactId={ARTIFACT_ID}
          artifactTitle={artifact.title}
          hostId={HOST_ID}
          viewTabId={VIEW_TAB_ID}
        >
          <CanvasArtifactSurface
            epicId={EPIC_ID}
            artifactId={ARTIFACT_ID}
            artifact={artifact}
          />
        </CanvasSelectionProvider>
      </div>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(
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
        <RequestContext>
          <EpicSessionContext.Provider value={epicHandle}>
            <EpicViewTabContext.Provider value={VIEW_TAB_ID}>
              <TabHostContext.Provider value={HOST_ID}>
                <TooltipProvider>
                  <CanvasArtifactFixtureProvider
                    value={{
                      doc,
                      awareness,
                      treePath: "canvas-play",
                      user: { name: "You", color: "#14b8a6" },
                      resolveOutsideReference: () => null,
                      readSpan: (hash, offset, length, signal) => {
                        signal.throwIfAborted();
                        const bytes = BYTES_BY_SHA.get(hash);
                        if (bytes === undefined)
                          return Promise.resolve({ unavailable: "missing" });
                        return Promise.resolve({
                          bytes: bytes.slice(offset, offset + length),
                          totalBytes: bytes.length,
                          mediaType: "text/html",
                        });
                      },
                    }}
                  >
                    <CanvasPlayFixture />
                  </CanvasArtifactFixtureProvider>
                </TooltipProvider>
              </TabHostContext.Provider>
            </EpicViewTabContext.Provider>
          </EpicSessionContext.Provider>
        </RequestContext>
      </HostRuntimeProvider>
    </RunnerHostProvider>
  </QueryClientProvider>,
);
