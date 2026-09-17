import { ArrowUpRight, Globe2 } from "lucide-react";
import type { BrowserSessionReference } from "@traycer/protocol/persistence/epic/content-blocks";
import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import { Button } from "@/components/ui/button";
import { useBrowserSessionsForHost } from "@/components/epic-canvas/renderers/use-browser-sessions";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import {
  useHostReachability,
  type HostReachabilityStatus,
} from "@/hooks/agent/use-host-reachability";
import { useOpenEpicId } from "@/lib/epic-selectors";
import { resolveTabTitle } from "@/lib/browser-view/browser-tab-display";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";

interface BrowserSessionRowProps {
  readonly session: BrowserSessionReference;
  readonly findUnitId: string;
}

interface BrowserSessionRowView {
  readonly tab: BrowserTabInfo | undefined;
  readonly status: string | null;
  readonly originalTabClosed: boolean;
  readonly title: string | null;
}

function hasReadyBrowserSessionInventory(
  session: BrowserSessionReference,
  inventory: BrowserSessionsState,
): boolean {
  return (
    inventory.hostId === session.hostId &&
    inventory.lifecycle === "live" &&
    inventory.inventoryReady
  );
}

function browserSessionRowStatus(args: {
  readonly ready: boolean;
  readonly inventory: BrowserSessionsState;
  readonly hostStatus: HostReachabilityStatus;
  readonly liveSession: BrowserSessionInfo | undefined;
  readonly tab: BrowserTabInfo | undefined;
}): string | null {
  const { ready, inventory, hostStatus, liveSession, tab } = args;
  if (!ready) {
    const loading =
      hostStatus !== "unreachable" &&
      (inventory.lifecycle === "connecting" ||
        (inventory.lifecycle === "live" && !inventory.inventoryReady));
    return loading ? "Loading browser…" : "Browser unavailable";
  }
  if (tab === undefined) {
    return liveSession?.tabs.some((item) => item.status === "closing")
      ? "Closing…"
      : "Closed";
  }
  return null;
}

function browserSessionRowView(args: {
  readonly session: BrowserSessionReference;
  readonly inventory: BrowserSessionsState;
  readonly hostStatus: HostReachabilityStatus;
}): BrowserSessionRowView {
  const { session, inventory, hostStatus } = args;
  const ready = hasReadyBrowserSessionInventory(session, inventory);
  const liveSession = ready
    ? inventory.items.find((item) => item.sessionId === session.sessionId)
    : undefined;
  const availableTabs =
    liveSession?.tabs.filter((tab) => tab.status !== "closing") ?? [];
  const tab: BrowserTabInfo | undefined =
    availableTabs.find((item) => item.tabId === session.tabId) ??
    availableTabs.at(0);
  return {
    tab,
    status: browserSessionRowStatus({
      ready,
      inventory,
      hostStatus,
      liveSession,
      tab,
    }),
    originalTabClosed:
      ready && tab !== undefined && tab.tabId !== session.tabId,
    title: tab === undefined ? (session.title ?? null) : resolveTabTitle(tab),
  };
}

export function BrowserSessionRow({
  session,
  findUnitId,
}: BrowserSessionRowProps) {
  const epicId = useOpenEpicId();
  const inventory = useBrowserSessionsForHost({
    hostId: session.hostId,
    scope: { kind: "epic", epicId },
  });
  const host = useHostReachability(session.hostId);
  const { openTile } = useEpicTileNavigation();
  const { tab, status, originalTabClosed, title } = browserSessionRowView({
    session,
    inventory,
    hostStatus: host.status,
  });

  return (
    <div
      data-chat-find-unit={findUnitId}
      className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-ui-sm"
    >
      <Globe2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate">
          Browser · {session.profile === "primary" ? "Primary" : "Isolated"}
          {title ? (
            <span className="text-muted-foreground"> · {title}</span>
          ) : null}
        </div>
        <div className="truncate text-ui-xs text-muted-foreground">
          {host.hostLabel}
          {originalTabClosed ? " · Original tab closed" : null}
          {status === null ? null : ` · ${status}`}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={tab === undefined}
        onClick={() => {
          if (tab === undefined) return;
          openTile(
            tileIntent(
              makeBrowserSessionTileRef({
                hostId: session.hostId,
                sessionId: session.sessionId,
                tabId: tab.tabId,
              }),
              { epicId },
              "explicit",
              "direct_ui",
            ),
          );
        }}
      >
        Open browser <ArrowUpRight aria-hidden className="size-3.5" />
      </Button>
    </div>
  );
}
