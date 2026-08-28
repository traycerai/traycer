import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Bug, Camera, Globe2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useMaybeBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  createBrowserDebugContextAttachment,
  requestBrowserContextAttachment,
  type BrowserContextAttachmentPayload,
  type BrowserDebugAttachLevel,
} from "@/lib/browser-view/browser-context-attachments";
import type {
  BrowserViewBridge,
  BrowserViewConsoleEntry,
  BrowserViewDebugSnapshot,
  BrowserViewNetworkEntry,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { isBrowserSessionTileRef } from "@/stores/epics/canvas/types";
import type {
  BrowserSessionTileRef,
  EpicCanvasState,
} from "@/stores/epics/canvas/types";
import {
  collectPanes,
  type TileLayoutNode,
  type TilePane,
} from "@/stores/epics/canvas/tile-tree";

/**
 * The browser tile a chat composer would attach from: the store holds both
 * halves already (the tile ref by identity, the pane by id), so the selector
 * returns exactly those two and `useShallow` settles re-renders. The tile KEY
 * is derived below rather than selected, because building it inside the
 * selector allocates a fresh object on every store tick.
 */
interface BrowserContextPointer {
  readonly tile: BrowserSessionTileRef;
  readonly paneId: string;
}

interface BrowserContextCandidate {
  readonly tile: BrowserSessionTileRef;
  readonly tileKey: BrowserViewTileKey;
}

interface ResolvedBrowserContextCandidate extends BrowserContextCandidate {
  readonly title: string;
  readonly pageUrl: string;
}

export function BrowserComposerContextChip(props: {
  readonly chatId: string;
  readonly chatInstanceId: string;
  readonly viewTabId: string;
}) {
  const runnerHost = useRunnerHost();
  const browserView = runnerHost.browserView;
  const sessions = useMaybeBrowserSessionsContext();
  const pointer = useEpicCanvasStore(
    useShallow((state) =>
      selectBrowserContextPointer(
        state.canvasByTabId[props.viewTabId] ?? null,
        props.chatInstanceId,
      ),
    ),
  );
  const session = sessions?.items.find(
    (item) =>
      item.hostId === pointer?.tile.hostId &&
      item.sessionId === pointer.tile.sessionId,
  );
  const tab = session?.tabs.find((item) => item.tabId === pointer?.tile.tabId);
  const candidate = useMemo<ResolvedBrowserContextCandidate | null>(
    () =>
      pointer !== null &&
      session?.runtime.kind === "electron" &&
      tab !== undefined
        ? {
            tile: pointer.tile,
            tileKey: {
              viewTabId: props.viewTabId,
              paneId: pointer.paneId,
              tileInstanceId: pointer.tile.instanceId,
              pageSessionId: pointer.tile.id,
            },
            title: tab.title ?? "Browser",
            pageUrl: tab.url,
          }
        : null,
    [pointer, props.viewTabId, session?.runtime, tab],
  );
  const [pendingLevel, setPendingLevel] =
    useState<BrowserDebugAttachLevel | null>(null);

  const attach = useCallback(
    (level: BrowserDebugAttachLevel): void => {
      if (browserView === null || candidate === null || pendingLevel !== null) {
        return;
      }
      setPendingLevel(level);
      void captureBrowserContext(browserView, candidate, level)
        .then((payload) =>
          requestBrowserContextAttachment(payload, {
            targetChatId: props.chatId,
          }),
        )
        .then((result) => {
          if (result.status === "attached") {
            toast.success("Attached browser context.");
            return;
          }
          toast.error("No chat composer is ready for browser context.");
        })
        .catch(() => {
          toast.error("Couldn't attach browser context.");
        })
        .finally(() => {
          setPendingLevel(null);
        });
    },
    [browserView, candidate, pendingLevel, props.chatId],
  );

  if (candidate === null) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 max-w-[min(50vw,18rem)] gap-1.5 px-2 text-ui-xs"
          disabled={browserView === null || pendingLevel !== null}
        >
          <Globe2 className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">Attach: {candidate.title}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(86vw,18rem)]">
        <DropdownMenuItem onSelect={() => attach("screenshot")}>
          <Camera className="size-4" />
          <span>Screenshot</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => attach("debug-errors")}>
          <Bug className="size-4" />
          <span>Screenshot + console/network errors</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => attach("debug-snapshot")}>
          <Send className="size-4" />
          <span>Full debug snapshot</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function captureBrowserContext(
  browserView: BrowserViewBridge,
  candidate: ResolvedBrowserContextCandidate,
  level: BrowserDebugAttachLevel,
): Promise<BrowserContextAttachmentPayload> {
  const capture = await browserView.capturePage(candidate.tileKey);
  const snapshot =
    level === "screenshot"
      ? emptyDebugSnapshot(candidate.tileKey)
      : await browserView.getDebugSnapshot(candidate.tileKey);
  const consoleEntries = consoleEntriesForLevel(level, snapshot.consoleEntries);
  const networkEntries = networkEntriesForLevel(level, snapshot.networkEntries);
  return createBrowserDebugContextAttachment({
    tile: candidate.tileKey,
    pageUrl: candidate.pageUrl,
    dataLevel: level,
    capture,
    consoleEntries,
    networkEntries,
  });
}

function consoleEntriesForLevel(
  level: BrowserDebugAttachLevel,
  entries: readonly BrowserViewConsoleEntry[],
): readonly BrowserViewConsoleEntry[] {
  if (level === "debug-errors") {
    return entries.filter((entry) => entry.level === "error");
  }
  if (level === "debug-snapshot") return entries;
  return [];
}

function networkEntriesForLevel(
  level: BrowserDebugAttachLevel,
  entries: readonly BrowserViewNetworkEntry[],
): readonly BrowserViewNetworkEntry[] {
  if (level === "debug-errors") {
    return entries.filter((entry) => entry.status === "failed");
  }
  if (level === "debug-snapshot") return entries;
  return [];
}

function selectBrowserContextPointer(
  canvas: EpicCanvasState | null,
  chatInstanceId: string,
): BrowserContextPointer | null {
  if (canvas === null || canvas.root === null) return null;
  const panes = panesSharingGroupWithTile(canvas.root, chatInstanceId);
  return panes.flatMap((pane) => activeBrowserInPane(canvas, pane))[0] ?? null;
}

function panesSharingGroupWithTile(
  node: TileLayoutNode,
  tileInstanceId: string,
): readonly TilePane[] {
  if (node.kind === "pane") return [];
  const childWithTile = node.children.find((child) =>
    layoutContainsTile(child, tileInstanceId),
  );
  if (childWithTile === undefined) {
    return node.children.flatMap((child) =>
      panesSharingGroupWithTile(child, tileInstanceId),
    );
  }
  return node.children
    .flatMap((child) => collectPanes(child))
    .filter((pane) => !pane.tabInstanceIds.includes(tileInstanceId));
}

function layoutContainsTile(
  node: TileLayoutNode,
  tileInstanceId: string,
): boolean {
  if (node.kind === "pane") {
    return node.tabInstanceIds.includes(tileInstanceId);
  }
  return node.children.some((child) =>
    layoutContainsTile(child, tileInstanceId),
  );
}

function activeBrowserInPane(
  canvas: EpicCanvasState,
  pane: TilePane,
): BrowserContextPointer[] {
  if (pane.activeTabId === null) return [];
  const tile = canvas.tilesByInstanceId[pane.activeTabId];
  if (tile === undefined) return [];
  if (!isBrowserSessionTileRef(tile)) return [];
  return [{ tile, paneId: pane.id }];
}

function emptyDebugSnapshot(
  tileKey: BrowserViewTileKey,
): BrowserViewDebugSnapshot {
  return {
    ...tileKey,
    consoleEntries: [],
    networkEntries: [],
  };
}
