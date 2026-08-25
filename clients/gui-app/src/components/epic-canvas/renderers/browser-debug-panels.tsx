import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, ChevronDown, ChevronUp, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  createBrowserConsoleAttachment,
  createBrowserNetworkAttachment,
  createBrowserScreenshotAttachment,
  requestBrowserContextAttachment,
} from "@/lib/browser-view/browser-context-attachments";
import {
  type BrowserViewConsoleEntry,
  type BrowserViewDebugSnapshotChange,
  type BrowserViewNetworkEntry,
  type BrowserViewStatus,
  type BrowserViewTileKey,
  type BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";
import { cn } from "@/lib/utils";

interface BrowserDebugPanelsProps {
  readonly browserView: BrowserViewBridge | null;
  readonly tileKey: BrowserViewTileKey;
  readonly pageUrl: string;
  readonly status: BrowserViewStatus;
  readonly targetChatId: string | null;
}

type BrowserPanelTab = "console" | "network";

const EMPTY_SNAPSHOT: BrowserViewDebugSnapshotChange = {
  viewTabId: "",
  paneId: "",
  tileInstanceId: "",
  pageSessionId: "",
  consoleEntries: [],
  networkEntries: [],
};

export function BrowserDebugPanels(props: BrowserDebugPanelsProps) {
  const { browserView, tileKey, pageUrl, status, targetChatId } = props;
  const [tab, setTab] = useState<BrowserPanelTab>("console");
  const [expanded, setExpanded] = useState(false);
  const [snapshot, setSnapshot] =
    useState<BrowserViewDebugSnapshotChange>(EMPTY_SNAPSHOT);
  const [capturePending, setCapturePending] = useState(false);
  const activeSnapshot = browserView === null ? EMPTY_SNAPSHOT : snapshot;
  const consoleErrorCount = useMemo(
    () =>
      activeSnapshot.consoleEntries.filter((entry) => entry.level === "error")
        .length,
    [activeSnapshot.consoleEntries],
  );
  const failedRequestCount = useMemo(
    () =>
      activeSnapshot.networkEntries.filter((entry) => entry.status === "failed")
        .length,
    [activeSnapshot.networkEntries],
  );

  useEffect(() => {
    if (browserView === null) return;
    let disposed = false;
    browserView
      .getDebugSnapshot(tileKey)
      .then((next) => {
        if (!disposed && isSnapshotForTile(next, tileKey)) setSnapshot(next);
      })
      .catch(ignoreBrowserPanelError);
    const subscription = browserView.onDebugSnapshotChange((change) => {
      if (isSnapshotForTile(change, tileKey)) setSnapshot(change);
    });
    return () => {
      disposed = true;
      subscription.dispose();
    };
  }, [browserView, tileKey]);

  const clearRows = useCallback(() => {
    if (browserView === null) return;
    void browserView.clearDebugEvents(tileKey).catch(ignoreBrowserPanelError);
  }, [browserView, tileKey]);

  const captureScreenshot = useCallback(() => {
    if (browserView === null || capturePending || status !== "ready") return;
    if (targetChatId === null) {
      toast.error("Open a chat beside this browser to send context.");
      return;
    }
    setCapturePending(true);
    void browserView
      .capturePage(tileKey)
      .then((capture) =>
        requestBrowserContextAttachment(
          createBrowserScreenshotAttachment({
            tile: tileKey,
            pageUrl,
            capture,
          }),
          { targetChatId },
        ),
      )
      .then(showAttachmentResult)
      .catch(() => {
        toast.error("Couldn't capture browser screenshot.");
      })
      .finally(() => {
        setCapturePending(false);
      });
  }, [browserView, capturePending, pageUrl, status, targetChatId, tileKey]);

  const sendConsoleEntry = useCallback(
    (entry: BrowserViewConsoleEntry) => {
      if (targetChatId === null) {
        toast.error("Open a chat beside this browser to send context.");
        return;
      }
      void requestBrowserContextAttachment(
        createBrowserConsoleAttachment({ tile: tileKey, pageUrl, entry }),
        { targetChatId },
      ).then(showAttachmentResult);
    },
    [pageUrl, targetChatId, tileKey],
  );

  const sendNetworkEntry = useCallback(
    (entry: BrowserViewNetworkEntry) => {
      if (targetChatId === null) {
        toast.error("Open a chat beside this browser to send context.");
        return;
      }
      void requestBrowserContextAttachment(
        createBrowserNetworkAttachment({ tile: tileKey, pageUrl, entry }),
        { targetChatId },
      ).then(showAttachmentResult);
    },
    [pageUrl, targetChatId, tileKey],
  );

  if (!expanded) {
    return (
      <BrowserDebugCollapsedRow
        consoleCount={activeSnapshot.consoleEntries.length}
        consoleErrorCount={consoleErrorCount}
        networkCount={activeSnapshot.networkEntries.length}
        networkFailedCount={failedRequestCount}
        onExpand={() => setExpanded(true)}
      />
    );
  }

  return (
    <div className="flex max-h-[min(38dvh,18rem)] min-h-[9rem] shrink-0 flex-col border-t border-border bg-canvas">
      <div className="flex min-h-0 items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (value === "console" || value === "network") setTab(value);
          }}
          className="min-w-0 flex-1 gap-0"
        >
          <TabsList variant="line" className="h-7">
            <TabsTrigger value="console" className="gap-1.5 text-ui-xs">
              Console
              <span className="rounded-sm bg-muted px-1 font-mono text-[0.625rem] text-muted-foreground">
                {activeSnapshot.consoleEntries.length}
              </span>
              {consoleErrorCount > 0 ? (
                <span className="rounded-sm bg-destructive/10 px-1 font-mono text-[0.625rem] text-destructive">
                  {consoleErrorCount}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="network" className="gap-1.5 text-ui-xs">
              Network
              <span className="rounded-sm bg-muted px-1 font-mono text-[0.625rem] text-muted-foreground">
                {activeSnapshot.networkEntries.length}
              </span>
              {failedRequestCount > 0 ? (
                <span className="rounded-sm bg-destructive/10 px-1 font-mono text-[0.625rem] text-destructive">
                  {failedRequestCount}
                </span>
              ) : null}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex shrink-0 items-center gap-1">
          <TooltipWrapper
            label="Capture screenshot"
            side="top"
            sideOffset={6}
            align="center"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Capture screenshot"
              disabled={
                browserView === null || capturePending || status !== "ready"
              }
              onClick={captureScreenshot}
            >
              <Camera />
            </Button>
          </TooltipWrapper>
          <TooltipWrapper
            label="Clear rows"
            side="top"
            sideOffset={6}
            align="center"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Clear browser debug rows"
              disabled={browserView === null}
              onClick={clearRows}
            >
              <Trash2 />
            </Button>
          </TooltipWrapper>
          <TooltipWrapper
            label="Collapse"
            side="top"
            sideOffset={6}
            align="center"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Collapse console and network"
              onClick={() => setExpanded(false)}
            >
              <ChevronDown />
            </Button>
          </TooltipWrapper>
        </div>
      </div>
      <Tabs value={tab} className="min-h-0 flex-1 gap-0">
        <TabsContent value="console" className="min-h-0 overflow-auto">
          <ConsoleRows
            entries={activeSnapshot.consoleEntries}
            onSendEntry={sendConsoleEntry}
          />
        </TabsContent>
        <TabsContent value="network" className="min-h-0 overflow-auto">
          <NetworkRows
            entries={activeSnapshot.networkEntries}
            onSendEntry={sendNetworkEntry}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BrowserDebugCollapsedRow(props: {
  readonly consoleCount: number;
  readonly consoleErrorCount: number;
  readonly networkCount: number;
  readonly networkFailedCount: number;
  readonly onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onExpand}
      aria-label="Show console and network"
      data-testid="browser-debug-panels-collapsed"
      className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-canvas px-3 py-1.5 text-ui-xs text-muted-foreground outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className={cn(props.consoleErrorCount > 0 && "text-destructive")}>
          Console {props.consoleCount}
          {props.consoleErrorCount > 0
            ? ` · ${props.consoleErrorCount} error${props.consoleErrorCount === 1 ? "" : "s"}`
            : ""}
        </span>
        <span
          className={cn(props.networkFailedCount > 0 && "text-destructive")}
        >
          Network {props.networkCount}
          {props.networkFailedCount > 0
            ? ` · ${props.networkFailedCount} failed`
            : ""}
        </span>
      </span>
      <ChevronUp className="size-3.5 shrink-0" aria-hidden />
    </button>
  );
}

function ConsoleRows(props: {
  readonly entries: readonly BrowserViewConsoleEntry[];
  readonly onSendEntry: (entry: BrowserViewConsoleEntry) => void;
}) {
  if (props.entries.length === 0) {
    return <EmptyPanelRows label="No console entries yet" />;
  }
  return (
    <div className="min-w-0">
      {props.entries.map((entry) => (
        <div
          key={entry.id}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-border/70 px-2 py-1.5 text-ui-xs"
        >
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "shrink-0 rounded-sm px-1.5 py-0.5 font-mono uppercase",
                  consoleLevelClassName(entry.level),
                )}
              >
                {entry.level}
              </span>
              <span className="truncate font-mono text-muted-foreground">
                {entry.source}
              </span>
              <span className="shrink-0 font-mono text-muted-foreground">
                {timeLabel(entry.timestamp)}
              </span>
            </div>
            <div className="mt-1 min-w-0 truncate font-mono text-foreground">
              {entry.text.length === 0 ? "(empty message)" : entry.text}
            </div>
            {entry.url === null ? null : (
              <div className="mt-0.5 truncate font-mono text-muted-foreground">
                {locationLabel(entry)}
              </div>
            )}
          </div>
          <TooltipWrapper
            label="Send console entry to agent"
            side="top"
            sideOffset={6}
            align="end"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Send console entry to agent"
              onClick={() => props.onSendEntry(entry)}
            >
              <Send />
            </Button>
          </TooltipWrapper>
        </div>
      ))}
    </div>
  );
}

function NetworkRows(props: {
  readonly entries: readonly BrowserViewNetworkEntry[];
  readonly onSendEntry: (entry: BrowserViewNetworkEntry) => void;
}) {
  if (props.entries.length === 0) {
    return <EmptyPanelRows label="No network requests yet" />;
  }
  return (
    <div className="min-w-0">
      {props.entries.map((entry) => (
        <div
          key={entry.id}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-border/70 px-2 py-1.5 text-ui-xs"
        >
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">
                {entry.method}
              </span>
              <span
                className={cn(
                  "shrink-0 font-mono",
                  networkStatusClassName(entry),
                )}
              >
                {networkStatusLabel(entry)}
              </span>
              {entry.durationMs === null ? null : (
                <span className="shrink-0 font-mono text-muted-foreground">
                  {entry.durationMs} ms
                </span>
              )}
            </div>
            <div className="mt-1 min-w-0 truncate font-mono text-foreground">
              {entry.url}
            </div>
            <div className="mt-0.5 flex min-w-0 gap-2 text-muted-foreground">
              {entry.resourceType === null ? null : (
                <span className="shrink-0 font-mono">{entry.resourceType}</span>
              )}
              {entry.mimeType === null ? null : (
                <span className="min-w-0 truncate font-mono">
                  {entry.mimeType}
                </span>
              )}
              {entry.fromCache ? (
                <span className="shrink-0 font-mono">cache</span>
              ) : null}
            </div>
          </div>
          <TooltipWrapper
            label="Send network request to agent"
            side="top"
            sideOffset={6}
            align="end"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Send network request to agent"
              onClick={() => props.onSendEntry(entry)}
            >
              <Send />
            </Button>
          </TooltipWrapper>
        </div>
      ))}
    </div>
  );
}

function EmptyPanelRows(props: { readonly label: string }) {
  return (
    <div className="flex h-full min-h-[7rem] items-center justify-center px-3 text-ui-sm text-muted-foreground">
      {props.label}
    </div>
  );
}

function showAttachmentResult(result: {
  readonly status: "attached" | "unhandled";
}): void {
  if (result.status === "attached") {
    toast.success("Sent browser context to the agent.");
    return;
  }
  toast.info("Browser context packaged.", {
    description: "Composer attach grants are wired in ticket 12.",
  });
}

function isSnapshotForTile(
  snapshot: BrowserViewDebugSnapshotChange,
  key: BrowserViewTileKey,
): boolean {
  return (
    snapshot.viewTabId === key.viewTabId &&
    snapshot.paneId === key.paneId &&
    snapshot.tileInstanceId === key.tileInstanceId &&
    snapshot.pageSessionId === key.pageSessionId
  );
}

function consoleLevelClassName(
  level: BrowserViewConsoleEntry["level"],
): string {
  if (level === "error") return "bg-destructive/10 text-destructive";
  if (level === "warning") return "bg-warning/10 text-warning-foreground";
  if (level === "info") return "bg-primary/10 text-primary";
  return "bg-muted text-muted-foreground";
}

function networkStatusClassName(entry: BrowserViewNetworkEntry): string {
  if (entry.status === "failed") return "text-destructive";
  if (entry.statusCode !== null && entry.statusCode >= 400) {
    return "text-destructive";
  }
  if (entry.statusCode !== null && entry.statusCode >= 300) {
    return "text-warning-foreground";
  }
  if (entry.status === "finished") return "text-primary";
  return "text-muted-foreground";
}

function networkStatusLabel(entry: BrowserViewNetworkEntry): string {
  if (entry.status === "failed") return "failed";
  if (entry.statusCode !== null) return String(entry.statusCode);
  return entry.status;
}

function locationLabel(entry: BrowserViewConsoleEntry): string {
  if (entry.url === null) return "";
  if (entry.lineNumber === null) return entry.url;
  const column = entry.columnNumber === null ? "" : `:${entry.columnNumber}`;
  return `${entry.url}:${entry.lineNumber}${column}`;
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ignoreBrowserPanelError(_error: unknown): void {}
