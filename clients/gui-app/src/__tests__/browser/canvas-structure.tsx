import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { parseHtmlSource } from "@traycer/html-source";
import type {
  ArtboardEdit,
  EpicEditArtboardRequest,
} from "@traycer/protocol/host/epic/artboard-edit";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import type { CanvasBoardDocument } from "@/components/canvas-artifact/canvas-board-document";
import { CanvasFrameRegistry } from "@/components/canvas-artifact/canvas-frame-registry";
import { useCanvasSelectionStore } from "@/components/canvas-artifact/canvas-selection-store";
import { CanvasStructureOverlay } from "@/components/canvas-artifact/canvas-structure-overlay";
import {
  alignElements,
  distributeElements,
  type CanvasAlignMode,
} from "@/components/canvas-artifact/canvas-structure-geometry";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { buildArtifactDocument } from "@/lib/sandbox/artifact-serving/artifact-document";
import { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { CanvasLayoutNode } from "@/lib/sandbox/canvas-layout-bridge";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import "@/index.css";

/**
 * THE STRUCTURE OVERLAY OVER A REAL BOARD, DRIVEN BY REAL POINTER INPUT.
 *
 * A real canvas page (`buildArtifactDocument` with the canvas bootstrap) runs
 * in an iframe and the real `SandboxBridgeHost` reads its geometry, so every
 * box and every `data-traycer-pos` marker is what Chrome laid out. The
 * production `CanvasStructureOverlay` (and the gesture hook inside it) is
 * placed over the frame the way the canvas places it: in an untransformed
 * overlay that shares the ancestor transform the board's zoom applies. The
 * only fake is the host: `epic.editArtboard` is answered by a handler that
 * records the request, so a spec reads exactly what a gesture would have saved.
 * `browser-tests/canvas-structure.spec.ts` drives it with trusted mouse input.
 *
 * Query: `zoom` scales the board (default 1). `board` picks what the page
 * holds: a row of cards (default), `order` / `order-equal` / `grid` rows whose
 * CSS decides the visual order, and `align`, `rtl-absolute`, `rtl-mixed`,
 * `margins` and `rtl` boxes whose insets, direction and margins decide where
 * a `left` or `top` write puts them.
 */
const NONCE = "browser-fixture-nonce";
const ARTIFACT_ID = "structure-artifact";
const BOARD_PATH = "boards/home.html";
const HOST_ID = "structure-host";
const EPIC_ID = "structure-epic";
const SERVED_SHA = "b".repeat(64);
const BOARD_WIDTH = 640;
const BOARD_HEIGHT = 360;
const STAGE_LEFT = 60;
const STAGE_TOP = 40;

const params = new URLSearchParams(window.location.search);
const zoom = Number(params.get("zoom") ?? "1");
const boardKind = params.get("board");

interface BoardSource {
  readonly css: string;
  readonly body: string;
}

/** Three cards in a row container; `cardStyles` is each card's own inline style. */
function rowBody(cardStyles: readonly [string, string, string]): string {
  const [a, b, c] = cardStyles;
  return `<div id="row" data-tid="row"><div class="card" data-tid="a" style="${a}">A</div><div class="card" data-tid="b" style="${b}">B</div><div class="card" data-tid="c" style="${c}">C</div></div>`;
}
const CARD_CSS = `.card{width:100px;height:60px;box-sizing:border-box;background:#cde;border:1px solid #567}`;
const FLEX_ROW_CSS = `#row{display:flex;gap:20px;position:absolute;left:40px;top:60px;width:480px}${CARD_CSS}`;
const GRID_ROW_CSS = `#row{display:grid;grid-template-columns:repeat(3,100px);gap:20px;position:absolute;left:40px;top:60px;width:380px}${CARD_CSS}`;

/**
 * Absolutely positioned boxes under one stage, each anchored differently. The
 * page reports their computed left/top/width as used pixels whichever side
 * they are anchored to, so what alignment writes must not change a size.
 * `plain-*` are ordinary left/top boxes: the control that must keep working.
 */
const ALIGN_BODY = `<div id="stage" data-tid="stage"><div class="box" data-tid="free" style="left:20px;top:20px;width:60px;height:24px">free</div><div class="box" data-tid="fixed-right" style="right:30px;top:70px;width:90px;height:24px">fixed right</div><div class="box" data-tid="auto-right" style="right:30px;top:120px">auto right</div><div class="box" data-tid="stretch" style="left:10px;right:10px;top:170px;height:24px">stretch</div><div class="box" data-tid="auto-bottom" style="left:300px;bottom:20px;width:60px">auto bottom</div><div class="box" data-tid="plain-a" style="left:20px;top:210px;width:60px;height:24px">a</div><div class="box" data-tid="plain-b" style="left:150px;top:240px;width:80px;height:24px">b</div><div class="box" data-tid="plain-c" style="left:290px;top:268px;width:40px;height:24px">c</div></div>`;
const ALIGN_CSS = `#stage{position:absolute;left:0;top:0;width:400px;height:300px}.box{position:absolute;box-sizing:border-box;background:#fdc;border:1px solid #765}`;

/**
 * Fixed-size absolute boxes in a right-to-left container, each with `left:0`
 * and its own `right`. Over-constrained, `right` wins there, so writing `left`
 * moves nothing.
 */
const RTL_ABSOLUTE_BODY = `<div id="stage" data-tid="stage" style="direction:rtl"><div class="box" data-tid="rtl-a" style="left:0;right:30px;top:20px;width:60px;height:24px">a</div><div class="box" data-tid="rtl-b" style="left:0;right:140px;top:70px;width:80px;height:24px">b</div><div class="box" data-tid="rtl-c" style="left:0;right:300px;top:120px;width:50px;height:24px">c</div></div>`;

/**
 * The same boxes under a right-to-left container whose own children are
 * `direction:ltr`: the containing block's direction decides, not the box's.
 */
const RTL_CONTAINER_LTR_CHILD_BODY = `<div id="stage" data-tid="stage" style="direction:rtl"><div class="box" data-tid="mix-a" style="direction:ltr;left:0;right:30px;top:20px;width:60px;height:24px">a</div><div class="box" data-tid="mix-b" style="direction:ltr;left:0;right:140px;top:70px;width:80px;height:24px">b</div></div>`;

/**
 * Fixed-size boxes pinned by both insets with automatic margins: they sit in
 * the middle of the span the insets leave, so a change to `left` moves them by
 * half of it, and a change to `top` likewise.
 */
const MARGIN_BODY = `<div id="stage" data-tid="stage"><div class="box" data-tid="m-a" style="left:0;right:500px;top:0;bottom:250px;width:60px;height:24px;margin:auto">a</div><div class="box" data-tid="m-b" style="left:0;right:300px;top:40px;bottom:150px;width:60px;height:24px;margin:auto">b</div><div class="box" data-tid="m-c" style="left:0;right:60px;top:120px;bottom:60px;width:60px;height:24px;margin:auto">c</div></div>`;
const WIDE_STAGE_CSS = `#stage{position:absolute;left:0;top:0;width:600px;height:300px}.box{position:absolute;box-sizing:border-box;background:#fdc;border:1px solid #765}`;

/**
 * Relative boxes in a right-to-left container. A relative box with an explicit
 * `right` wins over `left` there, so writing `left` moves nothing.
 */
const RTL_BODY = `<div id="stage" data-tid="stage" style="direction:rtl"><div class="rel" data-tid="rel-left" style="left:10px">left</div><div class="rel" data-tid="rel-right" style="right:30px">right</div></div>`;
const RTL_CSS = `#stage{position:absolute;left:0;top:0;width:400px;height:300px}.rel{position:relative;box-sizing:border-box;width:60px;height:24px;background:#dfc;border:1px solid #567}`;

const BOARDS: Readonly<Record<string, BoardSource>> = {
  row: { css: FLEX_ROW_CSS, body: rowBody(["", "", ""]) },
  // CSS `order` that matches the source order but fixes the visual order.
  order: {
    css: FLEX_ROW_CSS,
    body: rowBody(["order:1", "order:2", "order:3"]),
  },
  // One shared nonzero order: the visual order still follows the source.
  "order-equal": {
    css: FLEX_ROW_CSS,
    body: rowBody(["order:2", "order:2", "order:2"]),
  },
  grid: {
    css: GRID_ROW_CSS,
    body: rowBody([
      "grid-column:1;grid-row:1",
      "grid-column:2;grid-row:1",
      "grid-column:3;grid-row:1",
    ]),
  },
  align: { css: ALIGN_CSS, body: ALIGN_BODY },
  "rtl-absolute": {
    css: ALIGN_CSS,
    body: RTL_ABSOLUTE_BODY,
  },
  "rtl-mixed": { css: ALIGN_CSS, body: RTL_CONTAINER_LTR_CHILD_BODY },
  margins: { css: WIDE_STAGE_CSS, body: MARGIN_BODY },
  rtl: { css: RTL_CSS, body: RTL_BODY },
};

function boardSource(): BoardSource {
  if (boardKind !== null && Object.hasOwn(BOARDS, boardKind))
    return BOARDS[boardKind];
  return BOARDS.row;
}

const board = boardSource();
const boardHtml = `<!doctype html><html><head><style>html,body{margin:0}body{font:14px sans-serif}${board.css}</style></head><body>${board.body}</body></html>`;
const boardDocument: CanvasBoardDocument = {
  sha256: SERVED_SHA,
  text: boardHtml,
  parsed: parseHtmlSource(boardHtml),
};

/** What the spec reads of an edit request; the rest of the request is not its claim. */
interface RecordedEdit {
  readonly kind: string;
  readonly width: number | null;
  readonly height: number | null;
  /** The neighbour a move-element lands before; `null` for the end or no move. */
  readonly before:
    | {
        readonly kind: "position";
        readonly startTagOffset: number;
        readonly tagName: string;
      }
    | { readonly kind: "tid"; readonly tid: string }
    | null;
}

function recordOf(request: EpicEditArtboardRequest): RecordedEdit {
  const { edit } = request;
  switch (edit.kind) {
    case "set-box":
      return {
        kind: edit.kind,
        width: edit.width,
        height: edit.height,
        before: null,
      };
    case "move-element":
      return {
        kind: edit.kind,
        width: null,
        height: null,
        before: edit.before,
      };
    default:
      return { kind: edit.kind, width: null, height: null, before: null };
  }
}

interface StructureProbe {
  readonly ready: boolean;
  readonly select: (tid: string) => Promise<void>;
  /** The edit requests the fake host received, oldest first. */
  readonly edits: () => readonly RecordedEdit[];
  /** Aligns the elements through the production arithmetic and measures. */
  readonly alignAndMeasure: (
    tids: readonly string[],
    mode: CanvasAlignMode,
  ) => Promise<AlignMeasurement>;
  /** Distributes the elements through the production arithmetic and measures. */
  readonly distributeAndMeasure: (
    tids: readonly string[],
    axis: "x" | "y",
  ) => Promise<AlignMeasurement>;
}
interface ProbeWindow extends Window {
  __structureProbe?: StructureProbe;
}
interface AlignMeasurement {
  /** `false` when the production arithmetic refused the set. */
  readonly applied: boolean;
  readonly before: Readonly<Record<string, { width: number; height: number }>>;
  readonly after: Readonly<Record<string, { width: number; height: number }>>;
  /** Each element's left and top edge after the edit, in the page. */
  readonly edges: Readonly<Record<string, { x: number; y: number }>>;
}
const probeWindow: ProbeWindow = window;

const edits: EpicEditArtboardRequest[] = [];
const registry = new CanvasFrameRegistry();
registry.selectBoard(BOARD_PATH);

const queryClient = createAppQueryClient();
const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: {
    hostId: HOST_ID,
    websocketUrl: "ws://127.0.0.1:9/structure",
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
let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({
  registry: rpc,
}) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry: rpc,
    requestId: () => `structure-${String((requestCounter += 1))}`,
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
      }),
      "host.notifications.indicatorState": () => ({ epics: {}, chats: {} }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
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
epicHandle.store.setState({ durabilityStatus: null });

/** Holds the board back until the host client has its request context. */
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

function installBridge(
  iframe: HTMLIFrameElement,
  onReady: (bridge: SandboxBridgeHost) => void,
): () => void {
  const bridge = new SandboxBridgeHost({
    document: {
      kind: "served",
      canvas: true,
      nonce: NONCE,
      forwardedShortcuts: [],
      pages: null,
    },
    hostContext: {
      theme: "light",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      platform: "desktop",
    },
    hostVersion: "browser-test",
    post: (message) => iframe.contentWindow?.postMessage(message, "*"),
    events: {
      onStatus: (status) => {
        if (status === "ready") onReady(bridge);
      },
      onSize: () => undefined,
      onOpenLink: () => Promise.resolve(false),
      onShortcut: () => undefined,
      onRequestTeardown: () => undefined,
      onScrollGesture: () => undefined,
      onWheel: () => undefined,
    },
    appRequests: null,
  });
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source === iframe.contentWindow) bridge.receive(event.data);
  };
  const onLoad = (): void => bridge.frameLoaded();
  // The listeners are in place before the document exists, so neither the
  // load nor the page's ready message can be missed.
  window.addEventListener("message", onMessage);
  iframe.addEventListener("load", onLoad);
  iframe.srcdoc = buildArtifactDocument(boardHtml, {
    canvas: true,
    policySource: "traycer-sandbox:",
    csp: null,
    theme: {
      appliesToRoot: true,
      colorScheme: "light",
      background: null,
      variables: {},
    },
    nonce: NONCE,
    shortcuts: [],
  });
  return () => {
    window.removeEventListener("message", onMessage);
    iframe.removeEventListener("load", onLoad);
    bridge.dispose();
  };
}

function sizesOf(
  frameDocument: Document,
  tids: readonly string[],
): Record<string, { width: number; height: number }> {
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const tid of tids) {
    const rect = frameDocument
      .querySelector(`[data-tid="${tid}"]`)
      ?.getBoundingClientRect();
    if (rect !== undefined)
      sizes[tid] = { width: rect.width, height: rect.height };
  }
  return sizes;
}

/**
 * Asks the page for the siblings' layout, lets `arrange` (the production
 * arithmetic) turn it into an edit, writes the edit's declarations into the
 * board the way the saved source would carry them, and measures what Chrome
 * lays out afterwards.
 */
async function arrangeAndMeasure(
  iframe: HTMLIFrameElement,
  bridge: SandboxBridgeHost,
  tids: readonly string[],
  arrange: (nodes: readonly CanvasLayoutNode[]) => ArtboardEdit | null,
): Promise<AlignMeasurement> {
  const frameDocument = iframe.contentDocument;
  const first = tids.at(0);
  if (frameDocument === null || first === undefined)
    throw new Error("nothing to arrange");
  const before = sizesOf(frameDocument, tids);
  const layout = await bridge.siblingLayout({ tid: first });
  if (layout === null) throw new Error("the page gave no layout");
  const nodes = layout.siblings.filter(
    (node) => node.tid !== null && tids.includes(node.tid),
  );
  const edit = arrange(nodes);
  if (
    edit === null ||
    (edit.kind !== "align-elements" && edit.kind !== "distribute-elements")
  )
    return { applied: false, before, after: before, edges: {} };
  for (const placement of edit.elements) {
    const selector =
      placement.locator.kind === "tid"
        ? `[data-tid="${placement.locator.tid}"]`
        : `[data-traycer-pos="${String(placement.locator.startTagOffset)}"]`;
    // Not `instanceof HTMLElement`: the board is another realm's document.
    const target = frameDocument.querySelector<HTMLElement>(selector);
    if (target === null) throw new Error(`no ${selector}`);
    for (const declaration of placement.declarations)
      target.style.setProperty(declaration.property, declaration.value);
  }
  const edges: Record<string, { x: number; y: number }> = {};
  for (const tid of tids) {
    const rect = frameDocument
      .querySelector(`[data-tid="${tid}"]`)
      ?.getBoundingClientRect();
    if (rect !== undefined) edges[tid] = { x: rect.x, y: rect.y };
  }
  return {
    applied: true,
    before,
    after: sizesOf(frameDocument, tids),
    edges,
  };
}

function installProbe(
  iframe: HTMLIFrameElement,
  bridge: SandboxBridgeHost,
): void {
  probeWindow.__structureProbe = {
    ready: true,
    select: async (tid) => {
      const element = await bridge.describeElement({ tid });
      if (element === null) throw new Error(`the board has no ${tid}`);
      useCanvasSelectionStore.getState().select({
        artifactId: ARTIFACT_ID,
        boardPath: BOARD_PATH,
        page: null,
        servedSha256: SERVED_SHA,
        element,
        textRange: null,
      });
    },
    edits: () => edits.map(recordOf),
    alignAndMeasure: (tids, mode) =>
      arrangeAndMeasure(iframe, bridge, tids, (nodes) =>
        alignElements(nodes, mode),
      ),
    distributeAndMeasure: (tids, axis) =>
      arrangeAndMeasure(iframe, bridge, tids, (nodes) =>
        distributeElements(nodes, axis),
      ),
  };
}

export function CanvasStructureFixture(): ReactNode {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const selection = useCanvasSelectionStore((state) => state.selection);

  useEffect(() => {
    const iframe = frame.current;
    if (iframe === null) return;
    return installBridge(iframe, (bridge) => {
      registry.update(BOARD_PATH, {
        bridge,
        frame: iframe,
        sha256: SERVED_SHA,
        page: null,
      });
      installProbe(iframe, bridge);
      setReady(true);
    });
  }, []);

  return (
    <div style={{ position: "relative", width: 900, height: 600 }}>
      <div
        id="stage"
        data-ready={ready ? "true" : "false"}
        style={{
          position: "absolute",
          left: STAGE_LEFT,
          top: STAGE_TOP,
          width: BOARD_WIDTH,
          height: BOARD_HEIGHT,
          transform: `scale(${zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <iframe
          id="board"
          ref={frame}
          title="board"
          style={{
            display: "block",
            width: BOARD_WIDTH,
            height: BOARD_HEIGHT,
            border: 0,
            background: "#fff",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
          }}
        >
          {selection === null ? null : (
            <CanvasStructureOverlay
              selection={selection}
              registry={registry}
              document={boardDocument}
            />
          )}
        </div>
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
            <TabHostContext.Provider value={HOST_ID}>
              <TooltipProvider>
                <CanvasStructureFixture />
              </TooltipProvider>
            </TabHostContext.Provider>
          </EpicSessionContext.Provider>
        </RequestContext>
      </HostRuntimeProvider>
    </RunnerHostProvider>
  </QueryClientProvider>,
);
