import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import type { EpicReadArtifactObjectRequest } from "@traycer/protocol/host/epic/artifact-objects";
import type { EpicEditArtboardRequest } from "@traycer/protocol/host/epic/artboard-edit";
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
import { HtmlArtifactCommentSurface } from "@/components/html-artifact/html-artifact-comment-surface";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  NO_OUTSIDE_REFERENCE,
  type ArtifactManifest,
  type ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving";
import { parseArtifactAddress } from "@/lib/sandbox/artifact-serving/artifact-address";
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
import { requestCommentThreadAnchorReveal } from "@/lib/comments/comment-editor-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * The real comment surface on one long HTML page, served the way a tile
 * serves it: the artifact bridge composes the document, and the spec drives
 * the loaded page with real input. A fresh load writes a new id onto the
 * root, so a spec can tell "still this document" from "loaded again".
 */
const EPIC_ID = "comment-mode-epic";
const ARTIFACT_ID = "comment-mode-artifact";
const VIEW_TAB_ID = "comment-mode-view";
const HOST_ID = "comment-mode-host";
const FRAME_TITLE = "Comment page";
const ENTRY_PATH = "index.html";
const PAGE_SHA = "a".repeat(64);
const DETAIL_PATH = "detail.html";
const DETAIL_SHA = "d".repeat(64);
const BROKEN_PATH = "broken.html";
const BROKEN_SHA = "e".repeat(64);
const SECTION_COUNT = 42;
const DEEP_SECTION = 32;

const sections = Array.from({ length: SECTION_COUNT }, (_, index) => {
  const number = index + 1;
  if (number === DEEP_SECTION) {
    // Rows short enough that a hit even a few pixels off lands on a
    // neighbour, which is what the zoomed hit test has to rule out.
    const rows = Array.from(
      { length: 5 },
      (_row, row) =>
        `<li id="row-${String(row + 1)}">Row ${String(row + 1)}</li>`,
    ).join("");
    return `<section class="block"><h2 id="deep" data-tid="deep">Section ${String(number)}</h2><p>The deep section.</p><ul class="rows">${rows}</ul></section>`;
  }
  return `<section class="block"><h2>Section ${String(number)}</h2><p>Paragraph ${String(number)} of the page.</p></section>`;
}).join("");

const PAGE_STYLE = `<style>
html,body{margin:0}
body{font:16px/1.4 sans-serif}
.controls{padding:16px;display:flex;flex-direction:column;align-items:flex-start;gap:8px}
button,a,summary{font:inherit}
#note{width:200px}
section{min-height:140px;padding:12px 16px;border-top:1px solid #ddd}
#deep,#marked{display:block;margin:0;padding:12px 16px;background:#e8eef8}
#fresh{margin:0;padding:12px 16px;background:#f4f0e6}
.rows{margin:0;padding:0;list-style:none}
.rows li{margin:0;padding:0;font-size:12px;line-height:14px}
</style>`;

const PAGE_CONTROLS = `<div class="controls">
<button id="counter" type="button">count 0</button>
<button id="touch" type="button">touch 0</button>
<a id="away" href="other.html">Leave</a>
<a id="detail" href="${DETAIL_PATH}">Detail</a>
<a id="broken" href="${BROKEN_PATH}">Broken</a>
<details id="fold"><summary id="fold-summary">Fold</summary><p>Inside the fold</p></details>
<input id="note" aria-label="Note">
<p id="fresh">A fresh paragraph to comment on.</p>
</div>`;

const PAGE_BEHAVIOR = `<script>
document.documentElement.dataset.loadId = String(Math.random());
document.documentElement.dataset.escaped = "0";
document.getElementById("counter").addEventListener("click", () => {
  const button = document.getElementById("counter");
  const next = Number(button.textContent.replace(/\\D/g, "") || "0") + 1;
  button.textContent = "count " + next;
});
document.getElementById("touch").addEventListener("touchend", () => {
  const next = Number(document.documentElement.dataset.touches || "0") + 1;
  document.documentElement.dataset.touches = String(next);
  document.getElementById("touch").textContent = "touch " + next;
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const next = Number(document.documentElement.dataset.escaped || "0") + 1;
  document.documentElement.dataset.escaped = String(next);
});
</script>`;

function pageDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">${PAGE_STYLE}</head><body>${body}${PAGE_BEHAVIOR}</body></html>`;
}

const PAGE_HTML = pageDocument(`${PAGE_CONTROLS}${sections}`);
const DETAIL_HTML = pageDocument(
  `${PAGE_CONTROLS}<p id="marked" data-tid="marked">Marked on the detail page.</p>`,
);

interface ServedFile {
  readonly status: number;
  readonly mediaType: string;
  readonly base64: string;
}
interface CommentModeProbe {
  readonly serve: (url: string) => Promise<ServedFile>;
  /** What the comments panel calls: select the thread, then ask its editor to reveal it. */
  readonly revealThread: (threadId: string) => void;
  readonly lastThreadId: () => string | null;
}
interface ProbeWindow extends Window {
  __commentModeProbe?: CommentModeProbe;
}
const probeWindow: ProbeWindow = window;

const pageBytes = new TextEncoder().encode(PAGE_HTML);
const detailBytes = new TextEncoder().encode(DETAIL_HTML);
const bytesBySha = new Map<string, Uint8Array>([
  [PAGE_SHA, pageBytes],
  [DETAIL_SHA, detailBytes],
]);

function manifestFile(
  sha256: string,
  bytes: Uint8Array,
): ArtifactManifest["files"][string] {
  return {
    sha256,
    byteLength: bytes.length,
    mediaType: "text/html",
    status: "local-only",
  };
}

let currentManifest: ArtifactManifest = {
  files: {
    [ENTRY_PATH]: manifestFile(PAGE_SHA, pageBytes),
    [DETAIL_PATH]: manifestFile(DETAIL_SHA, detailBytes),
    // Present, so a link here is a page whose bytes never arrive.
    [BROKEN_PATH]: {
      sha256: BROKEN_SHA,
      byteLength: 1,
      mediaType: "text/html",
      status: "local-only",
    },
  },
};
const manifestListeners = new Set<(manifest: ArtifactManifest) => void>();

function publishManifest(next: ArtifactManifest): void {
  currentManifest = next;
  for (const listener of manifestListeners) listener(next);
}

/** The bytes a later navigation must be served, published once the comment lands. */
let pendingStamp: {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
} | null = null;
let stampCount = 0;
let createdCount = 0;
let lastCreatedThreadId: string | null = null;

const readSpan: ArtifactReadSpan = (hash, offset, length, signal) => {
  signal.throwIfAborted();
  if (hash === BROKEN_SHA) return Promise.resolve({ unavailable: "failed" });
  const bytes = bytesBySha.get(hash);
  if (bytes === undefined) return Promise.resolve({ unavailable: "missing" });
  return Promise.resolve({
    bytes: bytes.slice(offset, offset + length),
    totalBytes: bytes.length,
    mediaType: "text/html",
  });
};

const SPAN_BYTES = 4 * 1024 * 1024;

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Native handlers reach the page through requests; the spec reaches this by `serve`. */
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
    const requestId = `comment-mode-${String((this.requestCounter += 1))}`;
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
probeWindow.__commentModeProbe = {
  serve: (url) => artifactBridge.serve(url),
  revealThread: (threadId) => {
    useCommentThreadsStore.getState().setActiveThread(EPIC_ID, threadId);
    requestCommentThreadAnchorReveal(EPIC_ID, ARTIFACT_ID, threadId);
  },
  lastThreadId: () => lastCreatedThreadId,
};

const files: Record<string, ArtifactObjectRef> = {
  [ENTRY_PATH]: {
    sha256: PAGE_SHA,
    byteLength: pageBytes.length,
    mediaType: "text/html",
    status: "local-only",
  },
};
const artifact: ArtifactProjection = {
  id: ARTIFACT_ID,
  kind: "html",
  title: FRAME_TITLE,
  layout: "folder",
  folderName: "comment-mode",
  parentId: null,
  artifactRoomId: "comment-mode-room",
  createdAt: 0,
  updatedAt: 0,
  status: null,
  createdManually: false,
  head: { files, capturedAt: 0 },
};

const DEEP_THREAD: CommentThreadWire = {
  threadId: "thread-deep",
  resolved: false,
  createdAt: 1,
  comments: [
    {
      commentId: "thread-deep-c1",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "about the deep section" }],
          },
        ],
      },
      createdAt: 1,
      updatedAt: null,
      author: { userId: "user-1", fallbackHandle: "You" },
    },
  ],
  data: {
    createdByUserId: "user-1",
    anchorKind: "element",
    artboard: ENTRY_PATH,
    elementId: "deep",
    label: "Section 32",
  },
};

const MARKED_THREAD: CommentThreadWire = {
  threadId: "thread-marked",
  resolved: false,
  createdAt: 2,
  comments: [
    {
      commentId: "thread-marked-c1",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "about the marked paragraph" }],
          },
        ],
      },
      createdAt: 2,
      updatedAt: null,
      author: { userId: "user-1", fallbackHandle: "You" },
    },
  ],
  data: {
    createdByUserId: "user-1",
    anchorKind: "element",
    artboard: DETAIL_PATH,
    elementId: "marked",
    label: "Marked",
  },
};

let threads: CommentThreadWire[] = [DEEP_THREAD, MARKED_THREAD];

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
epicHandle.store.setState({
  durabilityStatus: "local",
  recordsTransportStatus: "open",
  artifacts: { byId: { [ARTIFACT_ID]: artifact }, allIds: [ARTIFACT_ID] },
  commentThreads: { byArtifactId: { [ARTIFACT_ID]: threads } },
});
recordNegotiatedHostManifest(HOST_ID, {
  "epic.createCommentThread": { major: 1, minor: 3 },
});

const queryClient = createAppQueryClient();
const mockRunnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: {
    hostId: HOST_ID,
    websocketUrl: "ws://127.0.0.1:9/comment-mode",
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
// so the frame would show the desktop-only placeholder instead of the page.
const runnerHost: IRunnerHost = Object.assign(
  Object.create(MockRunnerHost.prototype) as IRunnerHost,
  mockRunnerHost,
  { sandboxArtifacts: artifactBridge },
);
let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `comment-mode-${String((requestCounter += 1))}`,
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
      "epic.readArtifactObject": (request: EpicReadArtifactObjectRequest) => {
        if (request.sha256 === BROKEN_SHA)
          return { kind: "unavailable", reason: "failed" };
        const bytes = bytesBySha.get(request.sha256);
        if (bytes === undefined)
          return { kind: "unavailable", reason: "missing" };
        return {
          kind: "text",
          text: new TextDecoder().decode(bytes),
          mediaType: "text/html",
          networkPolicy: "https-only",
        };
      },
      "epic.listCommentThreads": (_request: ListCommentThreadsRequest) => ({
        threads,
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
        const sha256After = stampCount.toString(16).padStart(64, "0");
        const stamped = new TextEncoder().encode(edited.text);
        // Available to the next read immediately. The manifest the frame is
        // serving moves only once the comment itself has been created, which
        // is after the live document has adopted this revision.
        bytesBySha.set(sha256After, stamped);
        pendingStamp = {
          path: request.boardPath,
          sha256: sha256After,
          bytes: stamped,
        };
        return {
          ok: true as const,
          tid,
          sha256After,
          splices: edited.splices,
        };
      },
      "epic.createCommentThread": (request: CreateCommentThreadRequest) => {
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
          threads = [...threads, thread];
          epicHandle.store.setState({
            commentThreads: { byArtifactId: { [ARTIFACT_ID]: threads } },
          });
          if (pendingStamp !== null && pendingStamp.path === anchor.artboard) {
            const stamped = pendingStamp;
            const previous = currentManifest.files[stamped.path];
            publishManifest({
              files: {
                ...currentManifest.files,
                [stamped.path]: {
                  ...previous,
                  sha256: stamped.sha256,
                  byteLength: stamped.bytes.length,
                },
              },
            });
            pendingStamp = null;
          }
        }
        lastCreatedThreadId = threadId;
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

export function CommentModeFixture(): ReactNode {
  const [manifest, setManifest] = useState(currentManifest);
  useEffect(() => {
    manifestListeners.add(setManifest);
    return () => {
      manifestListeners.delete(setManifest);
    };
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          // The runtime disposes itself when this function's identity changes.
          // A comment publishes a new manifest and re-renders here; a fresh
          // function would reload the page whose stamp was just adopted.
          remoteFetcher={fetchRemoteHosts}
          fallback={<div data-fixture-runtime-fallback />}
        >
          <RequestContext>
            <EpicSessionContext.Provider value={epicHandle}>
              <EpicViewTabContext.Provider value={VIEW_TAB_ID}>
                <TabHostContext.Provider value={HOST_ID}>
                  <TooltipProvider>
                    <div style={{ height: "100%", minHeight: 0 }}>
                      <HtmlArtifactCommentSurface
                        epicId={EPIC_ID}
                        artifactId={ARTIFACT_ID}
                        artifactTitle={FRAME_TITLE}
                        hostId={HOST_ID}
                        viewTabId={VIEW_TAB_ID}
                        source={{
                          kind: "artifact",
                          artifactId: ARTIFACT_ID,
                          treePath: "",
                          entryPath: ENTRY_PATH,
                          manifest,
                          readSpan,
                          resolveOutsideReference: NO_OUTSIDE_REFERENCE,
                        }}
                        toolbarControls={null}
                        menuItems={null}
                      />
                    </div>
                  </TooltipProvider>
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
createRoot(container).render(<CommentModeFixture />);
