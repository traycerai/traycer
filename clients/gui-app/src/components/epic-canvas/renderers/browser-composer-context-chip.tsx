import { useCallback, useState } from "react";
import { Bug, Camera, Globe2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
} from "@/lib/browser-view/browser-context-attachments";
import type {
  BrowserViewBridge,
  BrowserViewConsoleEntry,
  BrowserViewDebugSnapshotChange,
  BrowserViewNetworkEntry,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { isBrowserTileRef } from "@/stores/epics/canvas/types";
import type {
  BrowserTileRef,
  EpicCanvasState,
} from "@/stores/epics/canvas/types";
import {
  collectPanes,
  type TileLayoutNode,
  type TilePane,
} from "@/stores/epics/canvas/tile-tree";

type BrowserAttachLevel = "screenshot" | "debug-errors" | "debug-snapshot";

interface BrowserContextCandidate {
  readonly tile: BrowserTileRef;
  readonly tileKey: BrowserViewTileKey;
  readonly title: string;
}

const browserContextCandidateCache = new WeakMap<
  EpicCanvasState,
  Map<string, BrowserContextCandidate | null>
>();

export function BrowserComposerContextChip(props: {
  readonly chatId: string;
  readonly chatInstanceId: string;
  readonly viewTabId: string;
}) {
  const runnerHost = useRunnerHost();
  const browserView = runnerHost.browserView;
  const candidate = useEpicCanvasStore((state) =>
    selectStableBrowserContextCandidate(
      state.canvasByTabId[props.viewTabId] ?? null,
      props.viewTabId,
      props.chatInstanceId,
    ),
  );
  const [pendingLevel, setPendingLevel] = useState<BrowserAttachLevel | null>(
    null,
  );

  const attach = useCallback(
    (level: BrowserAttachLevel): void => {
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
  candidate: BrowserContextCandidate,
  level: BrowserAttachLevel,
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
    pageUrl: candidate.tile.url,
    dataLevel: level,
    capture,
    consoleEntries,
    networkEntries,
  });
}

function consoleEntriesForLevel(
  level: BrowserAttachLevel,
  entries: readonly BrowserViewConsoleEntry[],
): readonly BrowserViewConsoleEntry[] {
  if (level === "debug-errors") {
    return entries.filter((entry) => entry.level === "error");
  }
  if (level === "debug-snapshot") return entries;
  return [];
}

function networkEntriesForLevel(
  level: BrowserAttachLevel,
  entries: readonly BrowserViewNetworkEntry[],
): readonly BrowserViewNetworkEntry[] {
  if (level === "debug-errors") {
    return entries.filter((entry) => entry.status === "failed");
  }
  if (level === "debug-snapshot") return entries;
  return [];
}

function selectBrowserContextCandidate(
  canvas: EpicCanvasState | null,
  viewTabId: string,
  chatInstanceId: string,
): BrowserContextCandidate | null {
  if (canvas === null || canvas.root === null) return null;
  const panes = panesSharingGroupWithTile(canvas.root, chatInstanceId);
  const candidates = panes.flatMap((pane) =>
    activeBrowserInPane(canvas, pane, viewTabId),
  );
  return candidates[0] ?? null;
}

function selectStableBrowserContextCandidate(
  canvas: EpicCanvasState | null,
  viewTabId: string,
  chatInstanceId: string,
): BrowserContextCandidate | null {
  if (canvas === null) return null;
  const key = `${viewTabId}\u0000${chatInstanceId}`;
  const byKey = getBrowserContextCandidateCache(canvas);
  const previous = byKey.get(key);
  const next = selectBrowserContextCandidate(canvas, viewTabId, chatInstanceId);
  if (browserContextCandidatesEqual(previous, next)) {
    return previous ?? null;
  }
  byKey.set(key, next);
  return next;
}

function getBrowserContextCandidateCache(
  canvas: EpicCanvasState,
): Map<string, BrowserContextCandidate | null> {
  const existing = browserContextCandidateCache.get(canvas);
  if (existing !== undefined) return existing;
  const next = new Map<string, BrowserContextCandidate | null>();
  browserContextCandidateCache.set(canvas, next);
  return next;
}

function browserContextCandidatesEqual(
  a: BrowserContextCandidate | null | undefined,
  b: BrowserContextCandidate | null,
): boolean {
  if (a === b) return true;
  if (a === undefined || a === null || b === null) return false;
  return (
    a.tile === b.tile &&
    a.title === b.title &&
    a.tileKey.viewTabId === b.tileKey.viewTabId &&
    a.tileKey.paneId === b.tileKey.paneId &&
    a.tileKey.tileInstanceId === b.tileKey.tileInstanceId &&
    a.tileKey.pageSessionId === b.tileKey.pageSessionId
  );
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
  viewTabId: string,
): BrowserContextCandidate[] {
  if (pane.activeTabId === null) return [];
  const tile = canvas.tilesByInstanceId[pane.activeTabId];
  if (tile === undefined) return [];
  if (!isBrowserTileRef(tile)) return [];
  return [
    {
      tile,
      tileKey: {
        viewTabId,
        paneId: pane.id,
        tileInstanceId: tile.instanceId,
        pageSessionId: tile.id,
      },
      title: browserContextTitle(tile),
    },
  ];
}

function browserContextTitle(tile: BrowserTileRef): string {
  if (tile.name.length > 0 && tile.name !== "New browser") return tile.name;
  try {
    const parsed = new URL(tile.url);
    return parsed.hostname.length === 0 ? tile.url : parsed.hostname;
  } catch {
    return tile.url;
  }
}

function emptyDebugSnapshot(
  tileKey: BrowserViewTileKey,
): BrowserViewDebugSnapshotChange {
  return {
    ...tileKey,
    consoleEntries: [],
    networkEntries: [],
  };
}
