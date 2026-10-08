import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import {
  AlertTriangle,
  AppWindow,
  Check,
  Code2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RotateCw,
  ShieldAlert,
  X,
} from "lucide-react";
import type { JsonObject } from "@traycer/protocol/persistence/chat-sync/json";
import type { ToolCallMcpAppStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import { useChatAttachmentScope } from "@/components/chat/chat-attachment-scope-context";
import { SandboxFrame } from "@/components/sandbox/sandbox-frame";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { BlockFloatingToolbar } from "@/editor-core/nodes/shared/block-floating-toolbar";
import { ToolbarButton } from "@/editor-core/toolbar/toolbar-button";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import { useEpicFileTextQuery } from "@/hooks/files/use-epic-file-text-query";
import { formatByteSize } from "@/lib/format-byte-size";
import {
  canDownloadToDevice,
  downloadBlobToDevice,
  saveBlobToDisk,
} from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";
import { useOpenLink } from "@/lib/links/open-link";
import type {
  SandboxAppRequestHandler,
  SandboxBridgeHost,
  SandboxDisplayMode,
  SandboxSize,
  SandboxStatus,
} from "@/lib/sandbox/bridge-host";
import {
  createMcpAppRequestHandler,
  type McpAppApprovalRequest,
  type McpAppBridgeHandlers,
  type McpAppDownload,
  type McpAppUnreachableReason,
} from "@/lib/sandbox/mcp-app-bridge";
import { useMcpAppRpc } from "@/lib/sandbox/mcp-app-rpc";
import {
  claimFullscreen,
  holdFullscreenBlocker,
  releaseFullscreen,
  yieldFullscreen,
  type FullscreenClaim,
} from "@/lib/sandbox/overlay-owner";
import type { SandboxPermission } from "@/lib/sandbox/sandbox-url";
import { deriveToolInputSummary } from "@/lib/segment-summary";
import { cn } from "@/lib/utils";
import { insertAppMessageDraft } from "@/stores/composer/app-message-draft-store";

export interface McpAppRowProps {
  readonly id: string;
  readonly app: ToolCallMcpAppStamp;
  /** The ordinary tool row: shown when the app cannot run here. */
  readonly fallback: ReactNode;
}

/** Until the app reports its own height. */
const INITIAL_APP_HEIGHT_PX = 160;
const MIN_APP_HEIGHT_PX = 40;
const MAX_APP_HEIGHT_PX = 4000;
/** A host call slower than this is shown as waking the agent session. */
const WAKING_AFTER_MS = 700;

/**
 * Chromium refuses camera, microphone and location to an opaque origin, so
 * only clipboard-write is passed on; the others fail closed (D41).
 */
function grantedPermissions(
  app: ToolCallMcpAppStamp,
): readonly SandboxPermission[] {
  return app.permissions.filter(
    (permission): permission is "clipboard-write" =>
      permission === "clipboard-write",
  );
}

/**
 * An MCP App, rendered in place of the tool call that produced it (McpApp
 * state 1): a label line, then the app in the shared sandbox frame, with a
 * border only when the app asks for one (D40). A reader with no chat scope
 * (a published transcript) sees the ordinary tool row (state 6).
 */
export function McpAppRow(props: McpAppRowProps): ReactNode {
  const scope = useChatAttachmentScope();
  if (scope === null) return props.fallback;
  return (
    <LiveMcpApp
      id={props.id}
      app={props.app}
      fallback={props.fallback}
      epicId={scope.epicId}
      chatId={scope.chatId}
      hostId={scope.hostId}
    />
  );
}

/** Handlers that forward to whatever the row rendered last. */
function latestHandlers(
  ref: RefObject<McpAppBridgeHandlers>,
): McpAppBridgeHandlers {
  return {
    beginHostCall: () => ref.current.beginHostCall(),
    onReachability: (reason) => ref.current.onReachability(reason),
    askApproval: (request) => ref.current.askApproval(request),
    insertDraft: (text) => ref.current.insertDraft(text),
    requestDisplayMode: (mode) => ref.current.requestDisplayMode(mode),
    confirmDownload: (downloads) => ref.current.confirmDownload(downloads),
    saveFile: (file) => ref.current.saveFile(file),
    openLink: (url) => ref.current.openLink(url),
  };
}

interface PendingApproval {
  readonly request: McpAppApprovalRequest;
  readonly settle: (approved: boolean) => void;
}

interface PendingDownload {
  readonly downloads: readonly McpAppDownload[];
  readonly settle: (confirmed: boolean) => void;
}

function LiveMcpApp(props: {
  readonly id: string;
  readonly app: ToolCallMcpAppStamp;
  readonly fallback: ReactNode;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}) {
  const { id, app, epicId, chatId, hostId } = props;
  const rpc = useMcpAppRpc();
  const openLink = useOpenLink();
  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();
  const snapshot = useEpicFileTextQuery(hostId, {
    epicId,
    path: app.snapshot.path,
    sha256: app.snapshot.sha256,
    via: { chatId, blockId: id },
  });

  const [displayMode, setDisplayMode] = useState<SandboxDisplayMode>("inline");
  const [height, setHeight] = useState(INITIAL_APP_HEIGHT_PX);
  const [generation, setGeneration] = useState(0);
  const [crashed, setCrashed] = useState(false);
  const [closed, setClosed] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [waking, setWaking] = useState(false);
  const [unreachable, setUnreachable] =
    useState<McpAppUnreachableReason | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [download, setDownload] = useState<PendingDownload | null>(null);

  const appRef = useRef<HTMLDivElement | null>(null);
  const approvalRef = useRef<HTMLDivElement | null>(null);
  const bridgeRef = useRef<SandboxBridgeHost | null>(null);
  const claimRef = useRef<FullscreenClaim | null>(null);
  const hostCallsRef = useRef({ count: 0, timer: 0 });
  // The open prompts, kept here as well as in state: they are settled from
  // outside React (a document going away, an unmount), synchronously.
  const promptsRef = useRef<{
    approval: PendingApproval | null;
    download: PendingDownload | null;
  }>({ approval: null, download: null });
  // One controller per frame document. Aborted when that document goes, so
  // none of its requests can act afterwards (`createMcpAppRequestHandler`).
  const documentRef = useRef(new AbortController());

  /**
   * The app's document is going (teardown, reload, crash, disposal): its
   * requests stop acting, and whatever it is waiting on is denied.
   */
  const invalidateDocument = (): void => {
    documentRef.current.abort();
    const { approval: openApproval, download: openDownload } =
      promptsRef.current;
    promptsRef.current = { approval: null, download: null };
    openApproval?.settle(false);
    openDownload?.settle(false);
    setApproval(null);
    setDownload(null);
  };

  const leaveFullscreen = (): void => {
    const claim = claimRef.current;
    claimRef.current = null;
    if (claim !== null) releaseFullscreen(claim);
    setDisplayMode("inline");
  };
  const enterFullscreen = (): boolean => {
    if (claimRef.current !== null) return true;
    const row = appRef.current?.closest("[data-message-id]") ?? null;
    const claim: FullscreenClaim = {
      // A yield has already released the claim; this only drops the mode.
      exit: () => {
        claimRef.current = null;
        setDisplayMode("inline");
      },
      pinnedRowKey: row?.getAttribute("data-message-id") ?? null,
    };
    if (!claimFullscreen(claim)) return false;
    claimRef.current = claim;
    setDisplayMode("fullscreen");
    return true;
  };

  // Everything the app's requests reach, read at call time: the request
  // handler outlives renders (the frame takes it once per document).
  const handlers: McpAppBridgeHandlers = {
    beginHostCall: () => {
      const calls = hostCallsRef.current;
      calls.count += 1;
      if (calls.count === 1) {
        calls.timer = window.setTimeout(() => setWaking(true), WAKING_AFTER_MS);
      }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        calls.count -= 1;
        if (calls.count > 0) return;
        window.clearTimeout(calls.timer);
        setWaking(false);
      };
    },
    onReachability: setUnreachable,
    askApproval: (request) =>
      new Promise((settle) => {
        // One question at a time: a second call while one waits is denied.
        if (promptsRef.current.approval !== null) {
          settle(false);
          return;
        }
        // No app goes fullscreen over the card while it is up.
        const release = holdFullscreenBlocker();
        const pending: PendingApproval = {
          request,
          settle: (approved) => {
            release();
            settle(approved);
          },
        };
        promptsRef.current = { ...promptsRef.current, approval: pending };
        setApproval(pending);
      }),
    insertDraft: (text) => insertAppMessageDraft(chatId, app.server, text),
    requestDisplayMode: (mode) => {
      if (mode === "fullscreen") return enterFullscreen() ? mode : "inline";
      if (mode === "inline") leaveFullscreen();
      return mode ?? (claimRef.current === null ? "inline" : "fullscreen");
    },
    confirmDownload: (downloads) =>
      new Promise((settle) => {
        if (promptsRef.current.download !== null) {
          settle(false);
          return;
        }
        const release = holdFullscreenBlocker();
        const pending: PendingDownload = {
          downloads,
          settle: (confirmed) => {
            release();
            settle(confirmed);
          },
        };
        promptsRef.current = { ...promptsRef.current, download: pending };
        setDownload(pending);
      }),
    saveFile: async (file) => {
      const blob = new Blob([file.bytes], { type: file.mimeType });
      const saved = canDownloadToDevice(fileSave)
        ? await downloadBlobToDevice(blob, file.name, fileSave)
        : await saveBlobToDisk(blob, file.name, fileSave);
      if (saved === null) return;
      toastSavedFile(
        saved,
        openSaved.mutate,
        fileSave,
        canDownloadToDevice(fileSave) ? "save" : "share",
      );
    },
    openLink: (url) => void openLink(url, "markdown", null),
  };
  const handlersRef = useRef(handlers);
  useLayoutEffect(() => {
    handlersRef.current = handlers;
  });

  // Built per request, at request time, so every handler read is the latest
  // and the request is bound to the document that made it.
  const appRequests = useCallback<SandboxAppRequestHandler>(
    (method, params) =>
      createMcpAppRequestHandler(
        rpc,
        { epicId, chatId, blockId: id },
        latestHandlers(handlersRef),
        documentRef.current.signal,
      )(method, params),
    [rpc, epicId, chatId, id],
  );

  // The fullscreen surface is a manual popover: the top layer escapes the
  // transcript row's containment without moving the frame, which would
  // reload the app. The row keeps its inline height meanwhile, and its
  // transcript row stays mounted (`useFullscreenPinnedRowKeys`).
  const shownFullscreenRef = useRef(false);
  useLayoutEffect(() => {
    const element = appRef.current;
    if (element === null) return;
    const want = displayMode === "fullscreen";
    if (want === shownFullscreenRef.current) return;
    shownFullscreenRef.current = want;
    if (want) element.showPopover();
    else element.hidePopover();
  }, [displayMode]);

  // Unmounting ends the document's requests, answers whatever the app still
  // waits on, and gives up the window's fullscreen.
  useEffect(() => {
    const calls = hostCallsRef.current;
    const prompts = promptsRef;
    const documents = documentRef;
    return () => {
      window.clearTimeout(calls.timer);
      documents.current.abort();
      const open = prompts.current;
      prompts.current = { approval: null, download: null };
      open.approval?.settle(false);
      open.download?.settle(false);
      const claim = claimRef.current;
      if (claim !== null) releaseFullscreen(claim);
    };
  }, []);
  useEffect(() => {
    approvalRef.current?.scrollIntoView({ block: "nearest" });
  }, [approval]);

  const decideApproval = (approved: boolean): void => {
    const open = promptsRef.current.approval;
    // A card from a document that has since gone answers nothing.
    if (open === null || open !== approval) return;
    promptsRef.current = { ...promptsRef.current, approval: null };
    open.settle(approved);
    setApproval(null);
  };
  const decideDownload = (confirmed: boolean): void => {
    const open = promptsRef.current.download;
    if (open === null || open !== download) return;
    promptsRef.current = { ...promptsRef.current, download: null };
    open.settle(confirmed);
    setDownload(null);
  };

  const handleBridge = (bridge: SandboxBridgeHost | null): void => {
    bridgeRef.current = bridge;
    if (bridge === null) {
      invalidateDocument();
      return;
    }
    // A new document: its own controller, whatever came before it.
    documentRef.current.abort();
    documentRef.current = new AbortController();
    // Held by the bridge until the app says `initialized`.
    bridge.notify("ui/notifications/tool-input", { arguments: app.toolInput });
    bridge.notify("ui/notifications/tool-result", app.toolResult);
  };
  /** Ask the app to tear down (2 s grace), then run `after`. */
  const tearDown = (after: () => void): void => {
    invalidateDocument();
    leaveFullscreen();
    const bridge = bridgeRef.current;
    if (bridge === null) {
      after();
      return;
    }
    void bridge.teardown().then(after);
  };
  const reload = (): void => {
    tearDown(() => {
      setCrashed(false);
      setClosed(false);
      setHeight(INITIAL_APP_HEIGHT_PX);
      setGeneration((value) => value + 1);
    });
  };
  const handleSize = (size: SandboxSize): void => {
    if (size.height === null) return;
    setHeight(
      Math.min(MAX_APP_HEIGHT_PX, Math.max(MIN_APP_HEIGHT_PX, size.height)),
    );
  };
  const handleStatus = (status: SandboxStatus): void => {
    if (status === "disposed") {
      invalidateDocument();
      return;
    }
    if (status !== "crashed") return;
    invalidateDocument();
    leaveFullscreen();
    setCrashed(true);
  };

  const label = (
    <AppLabelLine server={app.server} tool={app.tool} waking={waking} />
  );
  if (snapshot.isPending) {
    return (
      <AppFigure app={app}>
        {label}
        <Skeleton
          aria-hidden
          className="w-full opacity-60"
          style={{ height: INITIAL_APP_HEIGHT_PX }}
        />
      </AppFigure>
    );
  }
  // No snapshot to run (not on this host, failed, not HTML): the call reads
  // as the tool call it was.
  if (snapshot.isError || snapshot.data.kind !== "text") return props.fallback;
  const html = snapshot.data.text;
  const fullscreen = displayMode === "fullscreen";

  return (
    <AppFigure app={app}>
      {label}
      {unreachable === null ? null : (
        <UnreachableNotice server={app.server} reason={unreachable} />
      )}
      {closed || crashed ? (
        <AppStoppedNotice crashed={crashed} onShow={reload} />
      ) : (
        <div
          // Holds the row's place while the app is in the top layer.
          style={fullscreen ? { height } : undefined}
        >
          <div
            ref={appRef}
            popover="manual"
            aria-label={`${app.server} app`}
            className={cn(
              // `tc-node-page` lends the agent-page hover bar.
              "tc-node-page relative inset-auto m-0 block h-auto w-full overflow-visible border-0 bg-transparent p-0 text-inherit",
              "open:fixed open:inset-0 open:flex open:size-full open:flex-col open:bg-background",
            )}
          >
            {fullscreen ? (
              <div className="flex shrink-0 items-center gap-2 border-b border-canvas-border/70 px-3 py-1.5">
                {label}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={leaveFullscreen}
                >
                  <Minimize2 aria-hidden />
                  Exit full screen
                </Button>
              </div>
            ) : (
              <BlockFloatingToolbar label="App actions">
                <ToolbarButton
                  icon={<Maximize2 className="size-4" aria-hidden />}
                  label="Expand"
                  active={false}
                  onClick={() => {
                    if (enterFullscreen()) return;
                    // Another app holds the window's fullscreen: take it over,
                    // the way an explicit click should.
                    yieldFullscreen();
                    enterFullscreen();
                  }}
                  className="tc-editor-toolbar-button"
                />
                <AppMoreMenu
                  showDetails={showDetails}
                  onToggleDetails={() => setShowDetails((value) => !value)}
                  onReload={reload}
                />
              </BlockFloatingToolbar>
            )}
            <div
              className={cn(
                fullscreen
                  ? "min-h-0 flex-1"
                  : app.prefersBorder &&
                      "overflow-hidden rounded-lg border border-canvas-border/60",
              )}
            >
              <SandboxFrame
                key={generation}
                html={html}
                kind="app"
                title={`${app.server} · ${app.tool}`}
                // Apps run under their own CSP, built from `appCsp`.
                networkPolicy="https-only"
                appCsp={app.csp}
                permissions={grantedPermissions(app)}
                appRequests={appRequests}
                className=""
                height={fullscreen ? null : height}
                onSize={handleSize}
                onStatus={handleStatus}
                onRequestTeardown={() => tearDown(() => setClosed(true))}
                displayMode={displayMode}
                onBridge={handleBridge}
                ref={null}
              />
            </div>
          </div>
        </div>
      )}
      {approval === null ? null : (
        <AppApprovalCard
          ref={approvalRef}
          server={app.server}
          request={approval.request}
          onDecide={decideApproval}
        />
      )}
      {showDetails ? props.fallback : null}
      <AppDownloadConfirm
        server={app.server}
        downloads={download?.downloads ?? null}
        onDecide={decideDownload}
      />
    </AppFigure>
  );
}

function AppFigure(props: {
  readonly app: ToolCallMcpAppStamp;
  readonly children: ReactNode;
}) {
  return (
    <figure
      aria-label={`App: ${props.app.server} · ${props.app.tool}`}
      data-testid="mcp-app-row"
      data-find-skip=""
      data-quote-exclude=""
      className="m-0 flex flex-col gap-1"
    >
      {props.children}
    </figure>
  );
}

/** McpApp states 1 and 2: who made the app, or that its session is waking. */
function AppLabelLine(props: {
  readonly server: string;
  readonly tool: string;
  readonly waking: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 p-1 text-ui-sm text-muted-foreground">
      <AppWindow
        className="size-3.5 shrink-0 text-[var(--term-ansi-magenta)]"
        aria-hidden
      />
      <span className="shrink-0 font-medium text-foreground/85">
        {props.server}
      </span>
      <span aria-hidden className="shrink-0 opacity-40">
        ·
      </span>
      {props.waking ? (
        <span
          role="status"
          className="flex min-w-0 items-center gap-1.5"
          data-testid="mcp-app-waking"
        >
          <span className="truncate">Waking the agent session</span>
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        </span>
      ) : (
        <span className="min-w-0 truncate font-mono text-code-sm">
          {props.tool}
        </span>
      )}
    </div>
  );
}

function AppMoreMenu(props: {
  readonly showDetails: boolean;
  readonly onToggleDetails: () => void;
  readonly onReload: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolbarButton
          icon={<MoreHorizontal className="size-4" aria-hidden />}
          label="More"
          active={false}
          className="tc-editor-toolbar-button"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={props.onReload}>
          <RotateCw className="size-3.5" aria-hidden />
          Reload app
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={props.onToggleDetails}>
          <Code2 className="size-3.5" aria-hidden />
          {props.showDetails
            ? "Hide original tool call"
            : "Show original tool call"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const UNREACHABLE_COPY: Record<
  McpAppUnreachableReason,
  (server: string) => { readonly title: string; readonly detail: string }
> = {
  offline: (server) => ({
    title: `This app can't reach ${server} right now`,
    detail:
      "The chat's agent session is on a host that is offline. The app still shows its last result.",
  }),
  "not-owner": () => ({
    title: "Only the chat's owner can use this app",
    detail: "The app still shows its last result.",
  }),
  "session-changed": () => ({
    title: "This app's agent session has ended",
    detail:
      "The chat moved to a new agent session after this app ran. The app still shows its last result.",
  }),
  unsupported: () => ({
    title: "This app can't run tools here",
    detail:
      "The chat's agent or its host does not serve apps. The app still shows its last result.",
  }),
};

/** McpApp state 5. */
function UnreachableNotice(props: {
  readonly server: string;
  readonly reason: McpAppUnreachableReason;
}) {
  const copy = UNREACHABLE_COPY[props.reason](props.server);
  return (
    <div
      role="status"
      data-testid="mcp-app-unreachable"
      className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-ui-sm"
    >
      <AlertTriangle
        className="mt-0.5 size-3.5 shrink-0 text-warning-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-warning-foreground">{copy.title}</div>
        <div className="text-foreground/90">{copy.detail}</div>
      </div>
    </div>
  );
}

function AppStoppedNotice(props: {
  readonly crashed: boolean;
  readonly onShow: () => void;
}) {
  return (
    <div
      role="status"
      className="flex w-full items-center gap-2.5 rounded-md border border-canvas-border/40 bg-foreground/5 px-3 py-2 text-ui-sm"
    >
      <AppWindow
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1 text-muted-foreground">
        {props.crashed ? "This app stopped responding." : "This app closed."}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={props.onShow}>
        {props.crashed ? "Reload" : "Show app"}
      </Button>
    </div>
  );
}

/** The exact arguments as indented JSON: every key, id and nested value. */
function argumentsText(args: JsonObject): string {
  return JSON.stringify(args, null, 2);
}

/**
 * McpApp state 3: the app asked to run a tool the chat's permission mode
 * wants approved. The same card as the composer's pending approvals, plus
 * what is being approved in full: the host's title for the call, the exact
 * tool, and every argument the host returned, never cut. The summary line is
 * a convenience only; the arguments block is what the reader approves.
 */
function AppApprovalCard(props: {
  readonly ref: Ref<HTMLDivElement>;
  readonly server: string;
  readonly request: McpAppApprovalRequest;
  readonly onDecide: (approved: boolean) => void;
}) {
  const { ref, server, request, onDecide } = props;
  const summary = deriveToolInputSummary(request.tool, request.args);
  const title = request.title.trim();
  return (
    <div
      ref={ref}
      role="group"
      aria-label={`Approve ${request.tool} for the ${server} app`}
      data-testid="mcp-app-approval"
      className="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2.5 text-ui-sm"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-3.5 shrink-0 text-primary" aria-hidden />
        <span className="select-none font-medium uppercase text-overline text-primary">
          Approval needed
        </span>
        <span className="text-ui-xs text-muted-foreground">
          · the {server} app wants to run a tool
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span
          data-testid="mcp-app-approval-tool"
          className="font-mono text-code-sm break-all text-foreground/80"
        >
          {server} · {request.tool}
        </span>
        {title.length === 0 || title === request.tool ? null : (
          <span
            data-testid="mcp-app-approval-title"
            className="min-w-0 break-words text-foreground"
          >
            {title}
          </span>
        )}
        {summary === null ? null : (
          <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
            {summary}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-ui-xs font-medium text-muted-foreground">
          Arguments
        </span>
        <pre
          data-testid="mcp-app-approval-args"
          aria-label="Arguments"
          // Bounded and scrollable, never cut: the whole value is here.
          className="m-0 max-h-48 overflow-auto rounded-md border border-border/50 bg-foreground/3 px-2.5 py-2 font-mono text-code-sm break-all whitespace-pre-wrap text-foreground"
        >
          {argumentsText(request.args)}
        </pre>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onDecide(false)}
        >
          <X className="size-3.5" aria-hidden />
          Deny
        </Button>
        <Button type="button" size="sm" onClick={() => onDecide(true)}>
          <Check className="size-3.5" aria-hidden />
          Approve
        </Button>
      </div>
    </div>
  );
}

/**
 * The size line for a download: bytes we hold for an embedded file; for a
 * link, only what the app claims, said as such.
 */
function downloadSize(download: McpAppDownload): string {
  if (download.kind === "file")
    return formatByteSize(download.bytes.byteLength);
  return download.size === null
    ? "Size unknown"
    : `${formatByteSize(download.size)}, as reported by the app`;
}

/**
 * `ui/download-file` always asks. An embedded file shows its name and the
 * size of the bytes in hand. A link shows the full address it will open -
 * the name and size are the app's own words, so they never stand in for it.
 */
function AppDownloadConfirm(props: {
  readonly server: string;
  readonly downloads: readonly McpAppDownload[] | null;
  readonly onDecide: (confirmed: boolean) => void;
}) {
  const { downloads, onDecide } = props;
  const linksOnly =
    downloads !== null && downloads.every((item) => item.kind === "link");
  return (
    <Dialog
      open={downloads !== null}
      onOpenChange={(open) => {
        if (!open) onDecide(false);
      }}
    >
      <DialogContent
        layout="banded"
        className="flex max-h-[calc(var(--spacing-safe-dvh)-2rem)] w-full min-w-0 flex-col overflow-hidden"
        style={{ maxWidth: "min(92vw, 30rem)" }}
        showCloseButton={false}
      >
        <DialogHeader className="shrink-0 space-y-1">
          <DialogTitle>
            {linksOnly ? "Open this download?" : "Save this file?"}
          </DialogTitle>
          <DialogDescription>
            {linksOnly
              ? `The ${props.server} app wants to open:`
              : `The ${props.server} app wants to save:`}
          </DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex max-h-[40svh] min-h-0 list-none flex-col gap-2 overflow-y-auto px-5 py-3 text-ui-sm">
          {(downloads ?? []).map((item) => (
            <li
              key={`${item.kind}:${item.name}:${item.kind === "file" ? item.bytes.byteLength : item.url}`}
              data-testid="mcp-app-download-item"
              className="flex min-w-0 flex-col gap-0.5"
            >
              {item.kind === "link" ? (
                <span
                  data-testid="mcp-app-download-url"
                  className="font-mono break-all text-foreground"
                >
                  {item.url}
                </span>
              ) : null}
              <span
                className={cn(
                  "break-all",
                  item.kind === "link"
                    ? "text-ui-xs text-muted-foreground"
                    : "font-mono text-foreground",
                )}
              >
                {item.kind === "link" ? `Named “${item.name}”` : item.name}
              </span>
              <span className="text-ui-xs text-muted-foreground">
                {downloadSize(item)}
              </span>
            </li>
          ))}
        </ul>
        <DialogFooter className="shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onDecide(false)}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => onDecide(true)}>
            {linksOnly ? "Open" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
