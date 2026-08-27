import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { parseHttpUrl } from "@/lib/browser-view/browser-tab-display";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import {
  useSettingsStore,
  type BrowserLinkOpenMode,
} from "@/stores/settings/settings-store";

export type BrowserLinkKind = "markdown" | "terminal";
export type BrowserLinkOpenResult = "in-app" | "external" | "ignored";

export interface BrowserLinkSource {
  readonly viewTabId: string;
  readonly paneId: string;
  readonly hostId: string;
}

export interface BrowserLinkClickEvent {
  readonly altKey: boolean;
}

type BrowserPageOpenTileRequest = BrowserLinkSource & {
  readonly sessionId: string;
  readonly tabId: string;
  readonly url: string;
};

interface RouteBrowserLinkArgs {
  readonly runnerHost: Pick<IRunnerHost, "openExternalLink">;
  readonly source: BrowserLinkSource | null;
  readonly kind: BrowserLinkKind;
  readonly url: string;
  readonly event: BrowserLinkClickEvent | null;
  readonly openInApp: (source: BrowserLinkSource, url: string) => boolean;
}

export function routeBrowserLink(
  args: RouteBrowserLinkArgs,
): BrowserLinkOpenResult {
  const parsed = parseHttpUrl(args.url.trim());
  const settings = useSettingsStore.getState();
  if (
    args.kind === "terminal" &&
    parsed !== null &&
    looksLikeDevServer(parsed)
  ) {
    settings.addBrowserDevOrigin(parsed.origin);
  }

  if (parsed === null) {
    void args.runnerHost.openExternalLink(args.url);
    return "external";
  }
  const webUrl = parsed.href;

  if (args.source === null) {
    void args.runnerHost.openExternalLink(webUrl);
    return "external";
  }

  const openMode = browserLinkOpenModeForKind(args.kind);
  const override = args.event?.altKey === true;
  const openInApp = override ? openMode === "external" : openMode === "in-app";
  if (!openInApp) {
    void args.runnerHost.openExternalLink(webUrl);
    return "external";
  }

  if (!args.openInApp(args.source, webUrl)) {
    void args.runnerHost.openExternalLink(webUrl);
    return "external";
  }
  return "in-app";
}

export function normalizeBrowserAddressInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "about:blank";
  if (looksLikeLocalHttpAddressWithoutScheme(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function openBrowserSessionTileFromPage(
  request: BrowserPageOpenTileRequest,
): boolean {
  const store = useEpicCanvasStore.getState();
  const canvas = store.canvasByTabId[request.viewTabId];
  if (canvas === undefined || canvas.root === null) return false;
  const targetPane = findPaneById(canvas.root, request.paneId);
  if (targetPane === null) return false;
  const tile = makeBrowserSessionTileRef({
    hostId: request.hostId,
    sessionId: request.sessionId,
    tabId: request.tabId,
  });
  store.splitPaneWithNode(request.viewTabId, request.paneId, "right", tile);
  const nextCanvas =
    useEpicCanvasStore.getState().canvasByTabId[request.viewTabId];
  if (
    nextCanvas !== undefined &&
    nextCanvas.tilesByInstanceId[tile.instanceId] !== undefined
  ) {
    return true;
  }
  store.openTileInPane(request.viewTabId, request.paneId, tile);
  return true;
}

function browserLinkOpenModeForKind(
  kind: BrowserLinkKind,
): BrowserLinkOpenMode {
  const settings = useSettingsStore.getState();
  if (settings.browserLinkDefaultMode !== "per-kind") {
    return settings.browserLinkDefaultMode;
  }
  return kind === "terminal"
    ? settings.terminalBrowserLinkOpenMode
    : settings.markdownBrowserLinkOpenMode;
}

function looksLikeDevServer(url: URL): boolean {
  if (url.port.length > 0) return true;
  return isLoopbackLikeHost(url.hostname);
}

function looksLikeLocalHttpAddressWithoutScheme(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower === "localhost" ||
    lower.startsWith("localhost:") ||
    lower.startsWith("localhost/") ||
    lower.endsWith(".localhost") ||
    lower.includes(".localhost:") ||
    lower.startsWith("127.") ||
    lower.startsWith("0.0.0.0") ||
    lower.startsWith("[::1]") ||
    lower.startsWith("::1:")
  );
}

function isLoopbackLikeHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.startsWith("127.") ||
    lower === "0.0.0.0" ||
    lower === "::1" ||
    lower === "[::1]"
  );
}
