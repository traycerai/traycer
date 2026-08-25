import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";
import { Eye, ExternalLink, KeyRound, Radio } from "lucide-react";
import {
  browserSessionsServerFrameSchema,
  browserStorageStateSchema,
  type BrowserSessionInfo,
  type BrowserSessionsClientFrame,
  type BrowserSessionsServerFrame,
  type BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { Button } from "@/components/ui/button";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  authenticatedHostStreamKey,
  authenticatedOwnerIdentityKey,
} from "@/hooks/host/use-host-stream-client-for";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import {
  browserTileNameForUrl,
  openFreshBrowserTileFromBrowserPage,
} from "@/lib/browser-view/browser-link-routing-core";
import {
  clearBrowserTileControlRequest,
  publishBrowserTileControlActionRequest,
  publishBrowserTileControlRequest,
} from "@/lib/browser-view/browser-tile-control-store";
import { publishBorrowedTileCdpRequest } from "@/lib/browser-view/borrowed-tile-cdp";
import {
  collectNewAgentTabsFromSessionFrame,
  decideAgentTabDisposition,
  forgetSeenAgentTabsForSession,
  isEpicSurfaceVisible,
  isManualPipActive,
  openAgentTabInPip,
  placeAgentElectronTile,
  rememberElectronTabCreate,
  surfaceAgentTabsFromSessionFrame,
  trackAgentTabSurfaced,
} from "@/lib/browser-view/agent-tab-surfacing";
import {
  createElectronTabs,
  type ElectronTabPresentation,
  type ElectronTabs,
} from "@/lib/browser-view/electron-tabs";
import { browserCdpRequestFromFrame } from "@/lib/browser-view/browser-cdp-frames";
import {
  canCapturePrimaryProfile,
  resolveDesktopBrowserViewBridge,
  resolveDesktopElectronTabLifecycleBridge,
  type DesktopBrowserViewBridge,
  type DesktopElectronTabLifecycleBridge,
  type BrowserViewStorageStateCaptureResult,
  type BrowserViewStorageStateApplyResult,
  type BrowserViewTileKey,
} from "@/lib/browser-view/desktop-browser-view";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { makeBrowserPeekTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import {
  isBrowserTileRef,
  type EpicCanvasState,
} from "@/stores/epics/canvas/types";
import {
  BrowserSessionsContext,
  useBrowserSessionsContext,
  type BrowserSessionsLifecycle,
  type BrowserSessionsState,
} from "./browser-sessions-context";

/** Picks the session's lead tab for the dock's one-row summary. */
function primaryTab(session: BrowserSessionInfo): BrowserTabInfo | null {
  return session.tabs[0] ?? null;
}

/** Presentation is downstream of native readiness and host acceptance. */
function presentAcceptedElectronTab(tab: ElectronTabPresentation): void {
  if (tab.reason !== "agent-open") return;
  const disposition = decideAgentTabDisposition({
    mode: useSettingsStore.getState().agentTabSurfacingMode,
    epicVisible: isEpicSurfaceVisible(tab.epicId),
    manualPipActive: isManualPipActive(tab.epicId),
  });
  trackAgentTabSurfaced(disposition, "electron-create");
  if (disposition.action === "tile") {
    placeAgentElectronTile({
      epicId: tab.epicId,
      hostId: tab.hostId,
      sessionId: tab.sessionId,
      tabId: tab.tabId,
      url: tab.url,
    });
    return;
  }
  if (disposition.action === "float") {
    openAgentTabInPip({
      epicId: tab.epicId,
      hostId: tab.hostId,
      sessionId: tab.sessionId,
      tabId: tab.tabId,
    });
  }
}

type PromoteStateFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "promoteState" }
>;

type LendResultFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "lendResult" }
>;

type BrowserStorageLendPayload = Extract<
  BrowserSessionsClientFrame,
  { readonly kind: "lendStorage" }
>["storage"];

type PendingCloseRequest = {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

interface BrowserAuthLendSource {
  readonly id: string;
  readonly label: string;
  readonly origin: string;
  readonly bestEffort: boolean;
  readonly tileKey: BrowserViewTileKey;
}

interface BrowserAuthLendPreview {
  readonly session: BrowserSessionInfo;
  readonly source: BrowserAuthLendSource;
  readonly capture: BrowserViewStorageStateCaptureResult;
}

interface BrowserSessionsRenderState {
  readonly client: IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly items: readonly BrowserSessionInfo[];
  readonly lifecycle: BrowserSessionsLifecycle;
  readonly inventoryReady: boolean;
  readonly errorMessage: string | null;
}

function browserSessionsOwnerIdentityKey(
  hostClient: HostClient<HostRpcRegistry> | null,
  hostEntry: HostDirectoryEntry | null,
): string | null {
  return hostClient === null
    ? null
    : authenticatedOwnerIdentityKey(hostClient, hostEntry);
}

export function BrowserSessionsProvider(props: {
  readonly epicId: string;
  readonly routingChatId: string | null;
  readonly children: ReactNode;
}) {
  const hostId = useCanvasHostId();
  const hostClient = useEpicSessionHostClient();
  return (
    <BrowserSessionsHostProvider
      hostId={hostId}
      hostClient={hostClient}
      epicId={props.epicId}
      routingChatId={props.routingChatId}
    >
      {props.children}
    </BrowserSessionsHostProvider>
  );
}

export function BrowserSessionsHostProvider(props: {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly routingChatId: string | null;
  readonly children: ReactNode;
}) {
  const runnerHost = useRunnerHost();
  const browserView = useMemo(
    () => resolveDesktopBrowserViewBridge(runnerHost),
    [runnerHost],
  );
  const electronTabLifecycle = useMemo(
    () => resolveDesktopElectronTabLifecycleBridge(runnerHost),
    [runnerHost],
  );
  const primaryProfileCaptureReady = useMemo(
    () => canCapturePrimaryProfile(runnerHost),
    [runnerHost],
  );
  const sessions = useBrowserSessions({
    hostId: props.hostId,
    hostClient: props.hostClient,
    epicId: props.epicId,
    chatId: props.routingChatId,
    browserView,
    electronTabLifecycle,
    primaryProfileCaptureReady,
  });
  return (
    <BrowserSessionsContext.Provider
      value={{ ...sessions, routingChatId: props.routingChatId }}
    >
      {props.children}
    </BrowserSessionsContext.Provider>
  );
}

export interface BrowserSessionDockProps {
  readonly chatId: string;
  readonly viewTabId: string;
  readonly paneId: string;
}

export function BrowserSessionDock(props: BrowserSessionDockProps) {
  const hostId = useTabHostId();
  const runnerHost = useRunnerHost();
  const browserView = useMemo(
    () => resolveDesktopBrowserViewBridge(runnerHost),
    [runnerHost],
  );
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareSplitPaneWithNodeFocusTarget = useEpicCanvasStore(
    (state) => state.prepareSplitPaneWithNodeFocusTarget,
  );
  const epicId = useEpicCanvasStore(
    (state) => state.tabsById[props.viewTabId]?.epicId ?? null,
  );
  const sessions = useBrowserSessionsContext();
  const [handoffPendingId, setHandoffPendingId] = useState<string | null>(null);
  const [handoffMessage, setHandoffMessage] = useState<string | null>(null);
  const [lendPendingId, setLendPendingId] = useState<string | null>(null);
  const [lendMessage, setLendMessage] = useState<string | null>(null);
  const [lendPreview, setLendPreview] = useState<BrowserAuthLendPreview | null>(
    null,
  );
  const [selectedLendSourceId, setSelectedLendSourceId] = useState<
    string | null
  >(null);
  const canvas = useEpicCanvasStore(
    (state) => state.canvasByTabId[props.viewTabId] ?? null,
  );
  const lendSources = useMemo(
    () => selectBrowserAuthLendSources(canvas, props.viewTabId),
    [canvas, props.viewTabId],
  );
  const selectedLendSource =
    lendSources.find((source) => source.id === selectedLendSourceId) ??
    lendSources.at(0) ??
    null;

  const openPeek = useCallback(
    (session: BrowserSessionInfo) => {
      const tab = primaryTab(session);
      if (tab === null) return;
      const url = tab.url;
      const tile = makeBrowserPeekTileRef({
        name: `Peek ${browserTileNameForUrl(url)}`,
        hostId,
        chatId: props.chatId,
        sessionId: session.sessionId,
        tabId: tab.tabId,
        initialUrl: url,
      });
      const prepare = () =>
        prepareSplitPaneWithNodeFocusTarget(
          props.viewTabId,
          props.paneId,
          "right",
          tile,
        );
      if (epicId === null) {
        prepare();
        return;
      }
      navigateNested(epicId, props.viewTabId, prepare);
    },
    [
      epicId,
      hostId,
      navigateNested,
      prepareSplitPaneWithNodeFocusTarget,
      props.chatId,
      props.paneId,
      props.viewTabId,
    ],
  );

  const continueAtUrl = useCallback(
    (session: BrowserSessionInfo) => {
      setHandoffPendingId(session.sessionId);
      setHandoffMessage(null);
      sessions
        .requestPromoteState(session.sessionId)
        .then(async (state) => {
          const replayResult =
            browserView === null
              ? null
              : await browserView.applyStorageState({
                  storageState: browserStorageStateSchema.parse(
                    state.storageState,
                  ),
                  sessionId: session.sessionId,
                  tabId: session.tabs[0]?.tabId ?? null,
                  purpose: "sync-back",
                });
          openFreshBrowserTileFromBrowserPage({
            viewTabId: props.viewTabId,
            paneId: props.paneId,
            hostId,
            url: state.url,
          });
          setHandoffMessage(handoffResultMessage(replayResult));
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          setHandoffMessage(message);
        })
        .finally(() => {
          setHandoffPendingId(null);
        });
    },
    [browserView, hostId, props.paneId, props.viewTabId, sessions],
  );

  const reviewLendAuth = useCallback(
    (session: BrowserSessionInfo) => {
      const source = selectedLendSource;
      if (source === null) {
        setLendMessage("Open a browser tile at the site to lend first.");
        return;
      }
      if (browserView === null) {
        setLendMessage("Native browser storage capture is unavailable.");
        return;
      }
      setLendPendingId(session.sessionId);
      setLendMessage(null);
      setLendPreview(null);
      browserView
        .captureStorageState({
          ...source.tileKey,
          origin: source.origin,
        })
        .then((capture) => {
          setLendPreview({ session, source, capture });
        })
        .catch((error: unknown) => {
          setLendMessage(
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          setLendPendingId(null);
        });
    },
    [browserView, selectedLendSource],
  );

  const confirmLendAuth = useCallback(() => {
    if (lendPreview === null) return;
    setLendPendingId(lendPreview.session.sessionId);
    setLendMessage(null);
    sessions
      .requestLendStorage(
        lendPreview.session.sessionId,
        lendPreview.source.origin,
        browserStorageStateSchema.parse(lendPreview.capture.storageState),
      )
      .then((result) => {
        setLendMessage(
          lendResultMessage(lendPreview.source, lendPreview.capture, result),
        );
        setLendPreview(null);
      })
      .catch((error: unknown) => {
        setLendMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setLendPendingId(null);
      });
  }, [lendPreview, sessions]);

  if (sessions.items.length === 0 && sessions.lifecycle !== "failed") {
    return null;
  }

  return (
    <div
      className="border-t border-border bg-muted/35 px-3 py-2"
      data-testid="browser-session-dock"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-ui-sm font-medium">
          <Radio
            className={cn(
              "size-3.5 shrink-0",
              sessions.lifecycle === "live"
                ? "text-emerald-500"
                : "text-muted-foreground",
            )}
            aria-hidden
          />
          <span className="truncate">Agent browser sessions</span>
        </div>
        <div className="shrink-0 text-ui-xs text-muted-foreground">
          {browserSessionsLabel(sessions.lifecycle)}
        </div>
      </div>
      <div className="mb-2 flex min-w-0 items-center gap-2 text-ui-xs">
        <span className="shrink-0 text-muted-foreground">Review from</span>
        <select
          aria-label="Browser auth lend source site"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-ui-xs"
          disabled={lendSources.length === 0 || lendPendingId !== null}
          value={selectedLendSource === null ? "" : selectedLendSource.id}
          onChange={(event) => {
            setSelectedLendSourceId(event.target.value);
            setLendPreview(null);
          }}
        >
          {lendSources.length === 0 ? (
            <option value="">No visible browser site</option>
          ) : null}
          {lendSources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        {sessions.items.map((session) => (
          <div
            key={session.sessionId}
            className="flex min-w-0 items-center gap-2 rounded border border-border bg-background px-2 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-ui-sm font-medium">
                {primaryTab(session)?.title ??
                  browserTileNameForUrl(primaryTab(session)?.url ?? "")}
              </div>
              <div className="truncate font-mono text-ui-xs text-muted-foreground">
                {primaryTab(session)?.url ?? ""}
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-2 text-ui-xs"
              onClick={() => openPeek(session)}
            >
              <Eye className="size-3.5" />
              Peek
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-2 text-ui-xs"
              disabled={handoffPendingId !== null}
              onClick={() => continueAtUrl(session)}
            >
              <ExternalLink className="size-3.5" />
              Continue at URL (handoff)
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-2 text-ui-xs"
              disabled={
                lendPendingId !== null ||
                browserView === null ||
                selectedLendSource === null
              }
              onClick={() => reviewLendAuth(session)}
            >
              <KeyRound className="size-3.5" />
              Review auth
            </Button>
          </div>
        ))}
      </div>
      {lendPreview === null ? null : (
        <BrowserAuthLendConsent
          preview={lendPreview}
          pending={lendPendingId !== null}
          onCancel={() => setLendPreview(null)}
          onConfirm={confirmLendAuth}
        />
      )}
      <div className="mt-2 text-ui-xs text-muted-foreground">
        Handoff opens the captured URL in a visible browser and replays cookies
        when desktop cookie persistence is available. localStorage,
        sessionStorage, in-page JS, SPA state, and live sockets are not carried.
      </div>
      <div className="mt-1 text-ui-xs text-muted-foreground">
        Auth lending is one-shot from the selected visible browser site to one
        agent session. It lends the cookies your browser would send to that site
        plus same-origin localStorage when available. Localhost/dev sites are
        supported; external sites are best-effort and may reject replayed
        credentials.
      </div>
      {sessions.errorMessage === null &&
      handoffMessage === null &&
      lendMessage === null ? null : (
        <div className="mt-2 rounded border border-border bg-background px-2 py-1.5 text-ui-xs text-muted-foreground">
          {lendMessage ?? handoffMessage ?? sessions.errorMessage}
        </div>
      )}
    </div>
  );
}

function BrowserAuthLendConsent(props: {
  readonly preview: BrowserAuthLendPreview;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const cookieDomains = props.preview.capture.cookieDomains;
  const localStorageStatus = props.preview.capture.localStorageAvailable
    ? `${props.preview.capture.localStorageCount} ${localStorageItemLabel(
        props.preview.capture.localStorageCount,
      )} included`
    : `localStorage not included (${props.preview.capture.localStorageReason ?? "unavailable"})`;
  const scopeNotes = cookieScopeNotes(
    props.preview.source.origin,
    cookieDomains,
  );
  return (
    <div className="mt-2 rounded border border-border bg-background px-2 py-2 text-ui-xs">
      <div
        className="font-medium text-foreground"
        data-testid="browser-auth-lend-consent"
      >
        Lends the cookies your browser would send to{" "}
        <span className="font-mono">{props.preview.source.origin}</span>
      </div>
      <div className="mt-1 text-muted-foreground">
        Cookie domains ({props.preview.capture.cookieCount}):{" "}
        {cookieDomains.length === 0 ? "none" : cookieDomains.join(", ")}.
      </div>
      <div className="mt-1 text-muted-foreground">{localStorageStatus}.</div>
      {scopeNotes.map((note) => (
        <div key={note} className="mt-1 text-muted-foreground">
          {note}
        </div>
      ))}
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-ui-xs"
          disabled={props.pending}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-ui-xs"
          disabled={props.pending}
          onClick={props.onConfirm}
        >
          Confirm lend
        </Button>
      </div>
    </div>
  );
}

function handoffResultMessage(
  result: BrowserViewStorageStateApplyResult | null,
): string {
  if (result === null) {
    return "Opened a visible browser handoff at the captured URL. Cookie replay is unavailable in this runtime; localStorage, sessionStorage, in-page JS, SPA state, and live sockets are not carried.";
  }
  if (result.status === "skipped-degraded") {
    return `Opened a visible browser handoff at the captured URL without cookie replay because secure persistent browser cookies are unavailable (${result.reason}). localStorage, sessionStorage, in-page JS, SPA state, and live sockets are not carried.`;
  }
  const cookieLabel = result.cookieCount === 1 ? "cookie" : "cookies";
  return `Opened a visible browser handoff at the captured URL after replaying ${result.cookieCount} ${cookieLabel}. localStorage, sessionStorage, in-page JS, SPA state, and live sockets are not carried.`;
}

function lendResultMessage(
  source: BrowserAuthLendSource,
  capture: BrowserViewStorageStateCaptureResult,
  result: LendResultFrame,
): string {
  if (!result.ok) {
    return result.reason ?? "Auth lending failed.";
  }
  const cookieLabel = capture.cookieCount === 1 ? "cookie" : "cookies";
  const storageLabel =
    capture.localStorageCount === 1
      ? "localStorage item"
      : "localStorage items";
  const scope = source.bestEffort
    ? "External-site auth lending is best-effort; if the page still appears logged out, the site likely rejected replayed credentials."
    : "Localhost/dev auth lending is supported for agent verification.";
  const localStorageStatus = capture.localStorageAvailable
    ? `${capture.localStorageCount} ${storageLabel}`
    : `localStorage not captured (${capture.localStorageReason ?? "unavailable"})`;
  const hostReason = result.reason === null ? "" : ` ${result.reason}.`;
  return `Lent ${capture.cookieCount} ${cookieLabel} your browser would send to ${source.origin} and ${localStorageStatus}.${hostReason} ${scope}`;
}

function selectBrowserAuthLendSources(
  canvas: EpicCanvasState | null,
  viewTabId: string,
): readonly BrowserAuthLendSource[] {
  if (canvas === null || canvas.root === null) return [];
  const sources = collectPanes(canvas.root).flatMap(
    (pane): BrowserAuthLendSource[] => {
      if (pane.activeTabId === null) return [];
      const tile = canvas.tilesByInstanceId[pane.activeTabId];
      if (tile === undefined || !isBrowserTileRef(tile)) return [];
      const origin = httpOriginFromUrl(tile.url);
      if (origin === null) return [];
      const bestEffort = !isLocalDevOrigin(origin);
      return [
        {
          id: `${pane.id}:${tile.instanceId}`,
          label: `${origin}${bestEffort ? " (external best-effort)" : " (dev)"}`,
          origin,
          bestEffort,
          tileKey: {
            viewTabId,
            paneId: pane.id,
            tileInstanceId: tile.instanceId,
            pageSessionId: tile.id,
          },
        },
      ];
    },
  );
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.origin}\u001f${source.tileKey.tileInstanceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function httpOriginFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function isLocalDevOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "0.0.0.0" ||
      hostname === "127.0.0.1" ||
      hostname.startsWith("127.") ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function localStorageItemLabel(count: number): string {
  return count === 1 ? "localStorage item" : "localStorage items";
}

function cookieScopeNotes(
  origin: string,
  cookieDomains: readonly string[],
): readonly string[] {
  const notes: string[] = [];
  const parentDomains = cookieDomains.filter((domain) =>
    domain.startsWith("."),
  );
  if (parentDomains.length > 0) {
    notes.push(
      `Parent-domain cookies in this set can be shared with sibling apps: ${parentDomains.join(", ")}.`,
    );
  }
  if (isLocalhostCookieScopeOrigin(origin)) {
    notes.push("Localhost cookies are shared across ports.");
  }
  return notes;
}

function isLocalhostCookieScopeOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "0.0.0.0" ||
      hostname === "127.0.0.1" ||
      hostname.startsWith("127.") ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

interface UseBrowserSessionsArgs {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string | null;
  readonly browserView: DesktopBrowserViewBridge | null;
  readonly electronTabLifecycle: DesktopElectronTabLifecycleBridge | null;
  readonly primaryProfileCaptureReady: boolean;
}

function useBrowserSessions(
  args: UseBrowserSessionsArgs,
): Omit<BrowserSessionsState, "routingChatId"> {
  const {
    hostId,
    epicId,
    chatId,
    browserView,
    electronTabLifecycle,
    primaryProfileCaptureReady,
  } = args;
  const hostEntry = useHostDirectoryEntry(hostId ?? UNKNOWN_HOST_PLACEHOLDER);
  const transportReady =
    args.hostClient !== null &&
    authenticatedHostStreamKey(args.hostClient, hostEntry) !== null;
  const ownerIdentityKey = browserSessionsOwnerIdentityKey(
    args.hostClient,
    hostEntry,
  );
  const openTransport = useDurableStreamTransportFactory();
  // Keep an already-owned transport through a restart's transient non-dialable
  // directory state; its endpoint listener will redial when the new URL lands.
  const [readyOwner, setReadyOwner] = useState<{
    readonly hostId: string;
    readonly identityKey: string;
  } | null>(null);
  if (hostId === null || ownerIdentityKey === null) {
    if (readyOwner !== null) {
      setReadyOwner(null);
    }
  } else if (
    transportReady &&
    (readyOwner?.hostId !== hostId ||
      readyOwner.identityKey !== ownerIdentityKey)
  ) {
    setReadyOwner({ hostId, identityKey: ownerIdentityKey });
  }
  const sessionRef = useRef<{
    sendClientFrame: (
      frame: BrowserSessionsClientFrame,
      binaryPayload: Uint8Array | null,
    ) => void;
  } | null>(null);
  const pendingPromotesRef = useRef<
    Map<
      string,
      {
        readonly resolve: (frame: PromoteStateFrame) => void;
        readonly reject: (error: Error) => void;
      }
    >
  >(new Map());
  const pendingLendsRef = useRef<
    Map<
      string,
      {
        readonly resolve: (frame: LendResultFrame) => void;
        readonly reject: (error: Error) => void;
      }
    >
  >(new Map());
  const pendingClosesRef = useRef<Map<string, PendingCloseRequest>>(new Map());
  const [streamState, setStreamState] = useState<BrowserSessionsRenderState>(
    () => ({
      client: null,
      items: [],
      lifecycle: "connecting",
      inventoryReady: false,
      errorMessage: null,
    }),
  );
  const [retryGeneration, setRetryGeneration] = useState(0);
  const lifecycleRef = useRef(streamState.lifecycle);

  useEffect(() => {
    if (hostId === null || chatId === null || readyOwner?.hostId !== hostId) {
      sessionRef.current = null;
      return;
    }
    const pendingPromotes = pendingPromotesRef.current;
    const pendingLends = pendingLendsRef.current;
    const pendingCloses = pendingClosesRef.current;
    const transport = openTransport(hostId);
    const client = transport.wsStreamClient;
    const stream = (() => {
      try {
        return client.subscribe("browser.sessions", { epicId, chatId });
      } catch (cause) {
        transport.close();
        throw cause;
      }
    })();
    sessionRef.current = stream;
    // Keep one coordinator across this durable subscription's reconnects so
    // native settlements replay without exposing them to another host/epic.
    const electronTabs = createElectronTabs({
      epicId,
      hostId,
      native: electronTabLifecycle,
      sendFrame: (frame) => {
        stream.sendClientFrame(frame, null);
      },
      present: presentAcceptedElectronTab,
    });
    let captureReadySentForConnection = false;
    let electronLifecycleReadySentForConnection = false;
    let electronTabsReplayedForConnection = false;
    stream.onStatusChange((status, reason) => {
      if (sessionRef.current !== stream) return;
      const lifecycle = browserSessionsLifecycle(status, reason);
      lifecycleRef.current = lifecycle;
      if (status !== "open") {
        electronTabs.disconnect();
        captureReadySentForConnection = false;
        electronLifecycleReadySentForConnection = false;
        electronTabsReplayedForConnection = false;
        rejectPendingRequests(
          pendingCloses,
          new Error("Browser sessions stream closed."),
        );
      } else {
        if (!electronTabsReplayedForConnection) {
          electronTabsReplayedForConnection = true;
          electronTabs.replaySettlements();
        }
        if (
          electronTabLifecycle !== null &&
          !electronLifecycleReadySentForConnection
        ) {
          electronLifecycleReadySentForConnection = true;
          stream.sendClientFrame(
            {
              kind: "electronTabLifecycleReady",
              hasBinaryPayload: false,
              requestId: crypto.randomUUID(),
            },
            null,
          );
        }
        if (primaryProfileCaptureReady && !captureReadySentForConnection) {
          captureReadySentForConnection = true;
          stream.sendClientFrame(
            {
              kind: "primaryProfileCaptureReady",
              hasBinaryPayload: false,
              requestId: crypto.randomUUID(),
            },
            null,
          );
        }
      }
      setStreamState((current) => ({
        client,
        items: current.client === client ? current.items : [],
        lifecycle,
        inventoryReady: status === "open" && current.inventoryReady,
        errorMessage: browserSessionsError(status, reason),
      }));
    });
    stream.onServerFrame((envelope, binaryPayload) => {
      if (sessionRef.current !== stream) return;
      if (binaryPayload !== null) return;
      const parsed = browserSessionsServerFrameSchema.safeParse(envelope);
      if (!parsed.success) return;
      handleBrowserSessionsFrame({
        frame: parsed.data,
        setItems: (value) => {
          setStreamState((current) => {
            const currentItems = current.client === client ? current.items : [];
            const nextItems =
              typeof value === "function" ? value(currentItems) : value;
            return {
              client,
              items: nextItems,
              lifecycle:
                current.client === client ? current.lifecycle : "connecting",
              inventoryReady:
                parsed.data.kind === "snapshot" ||
                (current.client === client && current.inventoryReady),
              errorMessage:
                current.client === client ? current.errorMessage : null,
            };
          });
        },
        pendingPromotes,
        pendingLends,
        pendingCloses,
        browserView,
        electronTabs,
        sendClientFrame: (frame) => {
          stream.sendClientFrame(frame, null);
        },
      });
    });
    return () => {
      if (sessionRef.current === stream) {
        sessionRef.current = null;
      }
      electronTabs.dispose();
      stream.close();
      transport.close();
      rejectPendingRequests(
        pendingPromotes,
        new Error("Browser sessions stream closed."),
      );
      rejectPendingRequests(
        pendingLends,
        new Error("Browser sessions stream closed."),
      );
      rejectPendingRequests(
        pendingCloses,
        new Error("Browser sessions stream closed."),
      );
    };
  }, [
    browserView,
    chatId,
    electronTabLifecycle,
    epicId,
    hostId,
    openTransport,
    primaryProfileCaptureReady,
    readyOwner,
    retryGeneration,
  ]);

  const retry = useCallback(() => {
    setRetryGeneration((current) => current + 1);
  }, []);

  const requestPromoteState = useCallback((sessionId: string) => {
    const session = sessionRef.current;
    const pendingPromotes = pendingPromotesRef.current;
    if (session === null) {
      return Promise.reject(new Error("Browser sessions stream is not ready."));
    }
    const requestId = crypto.randomUUID();
    const promise = new Promise<PromoteStateFrame>((resolve, reject) => {
      pendingPromotes.set(requestId, { resolve, reject });
    });
    session.sendClientFrame(
      {
        kind: "getPromoteState",
        hasBinaryPayload: false,
        requestId,
        sessionId,
      },
      null,
    );
    return promise;
  }, []);

  const requestLendStorage = useCallback(
    (sessionId: string, origin: string, storage: BrowserStorageLendPayload) => {
      const session = sessionRef.current;
      const pendingLends = pendingLendsRef.current;
      if (session === null) {
        return Promise.reject(
          new Error("Browser sessions stream is not ready."),
        );
      }
      const requestId = crypto.randomUUID();
      const promise = new Promise<LendResultFrame>((resolve, reject) => {
        pendingLends.set(requestId, { resolve, reject });
      });
      session.sendClientFrame(
        {
          kind: "lendStorage",
          hasBinaryPayload: false,
          requestId,
          sessionId,
          origin,
          storage,
        },
        null,
      );
      return promise;
    },
    [],
  );

  const closeSession = useCallback((sessionId: string): void => {
    sessionRef.current?.sendClientFrame(
      {
        kind: "closeSession",
        hasBinaryPayload: false,
        requestId: crypto.randomUUID(),
        sessionId,
      },
      null,
    );
  }, []);

  const closeTab = useCallback(
    (sessionId: string, tabId: string): Promise<void> => {
      const session = sessionRef.current;
      if (session === null || lifecycleRef.current !== "live") {
        return Promise.reject(
          new Error("Browser sessions stream is not ready."),
        );
      }
      const pendingCloses = pendingClosesRef.current;
      const requestId = crypto.randomUUID();
      return new Promise<void>((resolve, reject) => {
        pendingCloses.set(requestId, { resolve, reject });
        try {
          session.sendClientFrame(
            {
              kind: "closeTab",
              hasBinaryPayload: false,
              requestId,
              sessionId,
              tabId,
            },
            null,
          );
        } catch (error) {
          pendingCloses.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    [],
  );

  const stateMatchesOwner =
    chatId !== null &&
    readyOwner?.hostId === hostId &&
    streamState.client !== null;
  const lifecycle = stateMatchesOwner ? streamState.lifecycle : "connecting";
  useEffect(() => {
    lifecycleRef.current = lifecycle;
  }, [lifecycle]);

  return {
    lifecycle,
    inventoryReady: stateMatchesOwner && streamState.inventoryReady,
    items: stateMatchesOwner ? streamState.items : [],
    errorMessage: stateMatchesOwner ? streamState.errorMessage : null,
    retry,
    closeSession,
    closeTab,
    requestPromoteState,
    requestLendStorage,
  };
}

function handleBrowserSessionRequestFrame(args: {
  readonly frame: BrowserSessionsServerFrame;
  readonly pendingPromotes: Map<
    string,
    {
      readonly resolve: (frame: PromoteStateFrame) => void;
      readonly reject: (error: Error) => void;
    }
  >;
  readonly pendingLends: Map<
    string,
    {
      readonly resolve: (frame: LendResultFrame) => void;
      readonly reject: (error: Error) => void;
    }
  >;
  readonly pendingCloses: Map<string, PendingCloseRequest>;
}): boolean {
  if (args.frame.kind === "promoteState") {
    const pending = args.pendingPromotes.get(args.frame.requestId);
    if (pending === undefined) return true;
    args.pendingPromotes.delete(args.frame.requestId);
    pending.resolve(args.frame);
    return true;
  }
  if (args.frame.kind === "lendResult") {
    const pending = args.pendingLends.get(args.frame.requestId);
    if (pending === undefined) return true;
    args.pendingLends.delete(args.frame.requestId);
    pending.resolve(args.frame);
    return true;
  }
  if (args.frame.kind === "actionAck") {
    const pendingClose = args.pendingCloses.get(args.frame.requestId);
    if (pendingClose !== undefined) {
      args.pendingCloses.delete(args.frame.requestId);
      if (args.frame.ok) pendingClose.resolve();
      else {
        pendingClose.reject(
          new Error(args.frame.reason ?? "Browser action failed."),
        );
      }
      return true;
    }
    if (!args.frame.ok) {
      const pending = args.pendingPromotes.get(args.frame.requestId);
      if (pending !== undefined) {
        args.pendingPromotes.delete(args.frame.requestId);
        pending.reject(
          new Error(args.frame.reason ?? "Browser action failed."),
        );
      }
      const pendingLend = args.pendingLends.get(args.frame.requestId);
      if (pendingLend !== undefined) {
        args.pendingLends.delete(args.frame.requestId);
        pendingLend.reject(
          new Error(args.frame.reason ?? "Browser action failed."),
        );
      }
      return true;
    }
  }
  return false;
}

function handleBrowserSessionsFrame(args: {
  readonly frame: BrowserSessionsServerFrame;
  readonly setItems: Dispatch<SetStateAction<readonly BrowserSessionInfo[]>>;
  readonly pendingPromotes: Map<
    string,
    {
      readonly resolve: (frame: PromoteStateFrame) => void;
      readonly reject: (error: Error) => void;
    }
  >;
  readonly pendingLends: Map<
    string,
    {
      readonly resolve: (frame: LendResultFrame) => void;
      readonly reject: (error: Error) => void;
    }
  >;
  readonly pendingCloses: Map<string, PendingCloseRequest>;
  readonly browserView: DesktopBrowserViewBridge | null;
  readonly electronTabs: ElectronTabs;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): void {
  if (args.frame.kind === "createElectronTab") {
    rememberElectronTabCreate(args.frame.sessionId, args.frame.tabId);
  }
  if (args.electronTabs.handleFrame(args.frame)) return;
  if (
    handlePrimaryProfileCaptureFrame({
      frame: args.frame,
      browserView: args.browserView,
      sendClientFrame: args.sendClientFrame,
    })
  ) {
    return;
  }
  if (
    handleBrowserSessionLifecycleFrame({
      frame: args.frame,
      setItems: args.setItems,
    })
  ) {
    return;
  }
  if (handleBrowserSessionRequestFrame(args)) return;
  if (
    handleVisibleTileControlFrame({
      frame: args.frame,
      sendClientFrame: args.sendClientFrame,
    })
  ) {
    return;
  }
  if (
    handleBorrowedTileCdpFrame({
      frame: args.frame,
      sendClientFrame: args.sendClientFrame,
    })
  ) {
    return;
  }
}

function handlePrimaryProfileCaptureFrame(args: {
  readonly frame: BrowserSessionsServerFrame;
  readonly browserView: DesktopBrowserViewBridge | null;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): boolean {
  if (args.frame.kind !== "capturePrimaryProfile") return false;
  const requestId = args.frame.requestId;
  const capturePrimaryProfile = args.browserView?.capturePrimaryProfile;
  if (capturePrimaryProfile === undefined) {
    args.sendClientFrame({
      kind: "primaryProfileCaptured",
      hasBinaryPayload: false,
      requestId,
      storageState: null,
      status: "unavailable",
      reason: "Desktop browser bridge is unavailable.",
    });
    return true;
  }
  void capturePrimaryProfile()
    .then((result) => {
      if (result.status === "unavailable") {
        args.sendClientFrame({
          kind: "primaryProfileCaptured",
          hasBinaryPayload: false,
          requestId,
          storageState: null,
          status: "unavailable",
          reason: result.reason,
        });
        return;
      }
      const parsed = browserStorageStateSchema.safeParse(result.storageState);
      args.sendClientFrame({
        kind: "primaryProfileCaptured",
        hasBinaryPayload: false,
        requestId,
        storageState: parsed.success ? parsed.data : null,
        status: parsed.success ? "captured" : "failed",
        reason: parsed.success
          ? null
          : "Desktop returned invalid storage state.",
      });
    })
    .catch((error: unknown) => {
      args.sendClientFrame({
        kind: "primaryProfileCaptured",
        hasBinaryPayload: false,
        requestId,
        storageState: null,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
}

function handleBrowserSessionLifecycleFrame(args: {
  readonly frame: BrowserSessionsServerFrame;
  readonly setItems: Dispatch<SetStateAction<readonly BrowserSessionInfo[]>>;
}): boolean {
  if (args.frame.kind === "snapshot") {
    for (const session of args.frame.sessions) {
      // Seed-only: a snapshot replays the full inventory (initial load,
      // reconnect, renderer reload) and must not re-surface old tabs.
      collectNewAgentTabsFromSessionFrame(session);
    }
    args.setItems(args.frame.sessions);
    return true;
  }
  if (args.frame.kind === "sessionCreated") {
    const session = args.frame.session;
    args.setItems((current) => upsertSession(current, session));
    // A session's inaugural tab stays quiet by design ("tabs only"); this
    // seeds the seen-tab set so later openTab additions are recognized.
    collectNewAgentTabsFromSessionFrame(session);
    return true;
  }
  if (args.frame.kind === "sessionUpdated") {
    const session = args.frame.session;
    args.setItems((current) => upsertSession(current, session));
    // Diff against the last seen tabs and apply the agent-tab-surfacing
    // preference to genuinely new agent-created tabs (headless sessions
    // never emit createElectronTab frames).
    surfaceAgentTabsFromSessionFrame(session);
    return true;
  }
  if (args.frame.kind === "sessionClosed") {
    const sessionId = args.frame.sessionId;
    forgetSeenAgentTabsForSession(sessionId);
    args.setItems((current) =>
      current.filter((session) => session.sessionId !== sessionId),
    );
    return true;
  }
  return false;
}

/**
 * Translates enumerated CDP frames for an explicitly borrowed user-owned
 * surface. Host-owned Electron tabs are handled earlier by ElectronTabs and
 * never enter this tile-addressed registry.
 */
function handleBorrowedTileCdpFrame(args: {
  readonly frame: BrowserSessionsServerFrame;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): boolean {
  const request = browserCdpRequestFromFrame(args.frame);
  if (request === null || request.target.kind !== "borrowed-tile") return false;
  publishBorrowedTileCdpRequest({
    requestId: request.requestId,
    tileInstanceId: request.target.tileInstanceId,
    cdpSessionId: request.cdpSessionId,
    command: request.command,
    sendFrame: args.sendClientFrame,
  });
  return true;
}

function handleVisibleTileControlFrame(args: {
  readonly frame: BrowserSessionsServerFrame;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): boolean {
  if (args.frame.kind === "visibleTileControlRequest") {
    publishBrowserTileControlRequest({
      requestId: args.frame.requestId,
      grantId: args.frame.grantId,
      chatId: args.frame.chatId,
      agentRunId: args.frame.agentRunId,
      agentLabel: args.frame.agentLabel,
      tileInstanceId: args.frame.tileInstanceId,
      origin: args.frame.origin,
      url: args.frame.url,
      requestedAt: args.frame.requestedAt,
      expiresAt: args.frame.expiresAt,
      sendFrame: args.sendClientFrame,
    });
    return true;
  }
  if (args.frame.kind === "visibleTileControlAction") {
    publishBrowserTileControlActionRequest({
      requestId: args.frame.requestId,
      grantId: args.frame.grantId,
      tileInstanceId: args.frame.tileInstanceId,
      action: args.frame.action,
      sendFrame: args.sendClientFrame,
    });
    return true;
  }
  if (args.frame.kind === "visibleTileControlResult" && !args.frame.ok) {
    clearBrowserTileControlRequest({
      tileInstanceId: args.frame.tileInstanceId,
      requestId: args.frame.requestId,
    });
    return true;
  }
  return false;
}

function upsertSession(
  current: readonly BrowserSessionInfo[],
  next: BrowserSessionInfo,
): readonly BrowserSessionInfo[] {
  const existing = current.findIndex(
    (session) => session.sessionId === next.sessionId,
  );
  if (existing === -1) return [...current, next];
  return current.map((session, index) => (index === existing ? next : session));
}

function browserSessionsLifecycle(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): BrowserSessionsLifecycle {
  if (reason?.kind === "fatalError") return "failed";
  if (status === "open") return "live";
  if (status === "reconnecting") return "reconnecting";
  if (status === "closed") return "closed";
  return "connecting";
}

function browserSessionsError(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): string | null {
  if (reason?.kind === "fatalError") return reason.details.reason;
  if (status === "reconnecting") return "Reconnecting browser sessions.";
  if (status === "closed") return "Browser sessions stream closed.";
  return null;
}

function browserSessionsLabel(lifecycle: BrowserSessionsLifecycle): string {
  if (lifecycle === "live") return "Live";
  if (lifecycle === "reconnecting") return "Reconnecting";
  if (lifecycle === "failed") return "Unavailable";
  if (lifecycle === "closed") return "Closed";
  return "Connecting";
}

function rejectPendingRequests<
  T extends { readonly reject: (error: Error) => void },
>(pendingRequests: Map<string, T>, error: Error): void {
  pendingRequests.forEach((pending) => pending.reject(error));
  pendingRequests.clear();
}
