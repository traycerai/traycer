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
import { CanvasArtifactSurface } from "@/components/canvas-artifact/canvas-artifact-surface";
import { CanvasSelectionProvider } from "@/components/canvas-artifact/canvas-selection-provider";
import { useCanvasSelectionStore } from "@/components/canvas-artifact/canvas-selection-store";
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
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * The canvas proof route's stack, so a click takes the production path: the
 * XYFlow wrapper, the board's edit overlay, the provider's hit test in a real
 * sandbox frame, and the editing panel. A fixture that sets the selection
 * store directly skips exactly the code a Shift-click depends on.
 *
 * Boards are served as the Android app serves them: from an `https` address no
 * network answers, which the spec fulfils by asking `__selectionProbe.serve`.
 * The only other fake is the host: it answers the board's source read and
 * records `epic.editArtboard`.
 */
const EPIC_ID = "selection-epic";
const ARTIFACT_ID = "selection-artifact";
const VIEW_TAB_ID = "selection-view";
const HOST_ID = "selection-host";
const BOARD_PATH = "boards/home.html";
const BOARD_TITLE = "Home";
const BOARD_SHA = "a".repeat(64);

/**
 * `first` and `second` are relative boxes with explicit offsets, so alignment
 * accepts them; `third` is a plain sibling; `elsewhere` lives in another
 * container.
 */
const BOARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}body{font:14px sans-serif}main,aside{position:absolute;left:20px;width:300px}main{top:20px}aside{top:220px}p{margin:0 0 8px;height:40px;box-sizing:border-box;padding:8px;background:#cde}.rel{position:relative;left:0;top:0}</style></head><body><main data-tid="group"><p class="rel" data-tid="first">First</p><p class="rel" data-tid="second">Second</p><p data-tid="third">Third</p></main><aside data-tid="other"><p data-tid="elsewhere">Elsewhere</p></aside></body></html>`;

interface ServedFile {
  readonly status: number;
  readonly mediaType: string;
  readonly base64: string;
}
interface SelectionProbe {
  readonly ready: boolean;
  /** The kinds of the edit requests the fake host received, oldest first. */
  readonly editKinds: () => readonly string[];
  /** The selected element's tid: the inspector sits behind its flag, so the
   * spec reads the selection itself instead of a panel describing it. */
  readonly selectedTid: () => string | null;
  /** Elements added to the selection beyond the first. */
  readonly additionalCount: () => number;
  /** The note a refused multi-pick leaves, e.g. the same-container rule. */
  readonly selectionNote: () => string | null;
  /** Answers one request for a mounted board file, as a native handler would. */
  readonly serve: (url: string) => Promise<ServedFile>;
}
interface ProbeWindow extends Window {
  __selectionProbe?: SelectionProbe;
}
const probeWindow: ProbeWindow = window;

const edits: EpicEditArtboardRequest[] = [];
const boardBytes = new TextEncoder().encode(BOARD_HTML);
const files: Record<string, ArtifactObjectRef> = {
  [BOARD_PATH]: {
    sha256: BOARD_SHA,
    byteLength: boardBytes.length,
    mediaType: "text/html",
    status: "local-only",
  },
};
const artifact: ArtifactProjection = {
  id: ARTIFACT_ID,
  kind: "canvas",
  title: "Selection",
  layout: "folder",
  folderName: "canvas-selection",
  parentId: null,
  artifactRoomId: "selection-room",
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
    title: "Selection",
    pages: [{ id: "page", name: "Page" }],
    boards: {
      [BOARD_PATH]: {
        x: 0,
        y: 0,
        w: 640,
        h: 420,
        title: BOARD_TITLE,
        page: "page",
        is_interactive: false,
      },
    },
    notes: {},
    order: [BOARD_PATH],
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
epicHandle.store.setState({
  durabilityStatus: null,
  artifacts: { byId: { [ARTIFACT_ID]: artifact }, allIds: [ARTIFACT_ID] },
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
    const requestId = `selection-${String((this.requestCounter += 1))}`;
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
    websocketUrl: "ws://127.0.0.1:9/selection",
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
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `selection-${String((requestCounter += 1))}`,
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
      }),
      "host.notifications.indicatorState": () => ({
        epics: {},
        chats: {},
        complete: true,
      }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
      // The editing panel reads the board's source by hash, as it does live.
      "epic.readArtifactObject": (request: EpicReadArtifactObjectRequest) =>
        request.sha256 === BOARD_SHA
          ? {
              kind: "text",
              text: BOARD_HTML,
              mediaType: "text/html",
              networkPolicy: "https-only",
            }
          : { kind: "unavailable", reason: "missing" },
      "epic.editArtboard": (request: EpicEditArtboardRequest) => {
        edits.push(request);
        return {
          ok: true,
          tid: null,
          sha256After: "c".repeat(64),
          splices: [],
        };
      },
    },
  });

probeWindow.__selectionProbe = {
  ready: true,
  editKinds: () => edits.map((request) => request.edit.kind),
  selectedTid: () =>
    useCanvasSelectionStore.getState().selection?.element.tid ?? null,
  additionalCount: () =>
    useCanvasSelectionStore.getState().additionalElements.length,
  selectionNote: () => useCanvasSelectionStore.getState().selectionMessage,
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
  return ready ? props.children : null;
}

export function CanvasSelectionFixture(): ReactNode {
  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <CanvasSelectionProvider
        epicId={EPIC_ID}
        artifactId={ARTIFACT_ID}
        artifactTitle={artifact.title}
        artifactType="canvas"
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
                      treePath: "canvas-selection",
                      user: { name: "You", color: "#14b8a6" },
                      resolveOutsideReference: () => null,
                      readSpan: (hash, offset, length, signal) => {
                        signal.throwIfAborted();
                        if (hash !== BOARD_SHA)
                          return Promise.resolve({ unavailable: "missing" });
                        return Promise.resolve({
                          bytes: boardBytes.slice(offset, offset + length),
                          totalBytes: boardBytes.length,
                          mediaType: "text/html",
                        });
                      },
                    }}
                  >
                    <CanvasSelectionFixture />
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
