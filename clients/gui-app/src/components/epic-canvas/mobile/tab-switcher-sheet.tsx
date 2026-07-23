import { Suspense, lazy, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { SwitcherCategoryTabs } from "@/components/epic-canvas/mobile/switcher-category-tabs";
import {
  MOBILE_SWITCHER_CATEGORY_DEFS,
  clampToSwitcherCategory,
  isSwitcherCategory,
} from "@/components/epic-canvas/mobile/switcher-categories";
import { SwitcherAgentsList } from "@/components/epic-canvas/mobile/switcher-agents-list";
import { SwitcherTerminalsList } from "@/components/epic-canvas/mobile/switcher-terminals-list";
import { SwitcherArtifactsList } from "@/components/epic-canvas/mobile/switcher-artifacts-list";
import { selectMobileTile } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { useEpicCanvas } from "@/stores/epics/canvas/store";
import {
  isGitDiffTileRef,
  isSnapshotDiffTileRef,
  isWorkspaceFileRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { useIsMobile } from "@/hooks/ui/use-mobile";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import {
  useActiveLeftPanelId,
  useLeftPanelStore,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";
import { cn } from "@/lib/utils";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

// Lazy so the desktop File-tree / Git-diff bodies - and the heavy epic-sidebar
// module they pull in - load only when a phone user opens those categories, and
// never sit in the mobile tile view's eager module graph.
const SwitcherPanelEmbed = lazy(() =>
  import("@/components/epic-canvas/mobile/switcher-panel-embed").then((m) => ({
    default: m.SwitcherPanelEmbed,
  })),
);

interface TabSwitcherSheetProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Tile kinds only the embedded File-tree / Git-diff bodies open. */
function isEmbedOriginatedTileRef(ref: EpicCanvasTileRef): boolean {
  return (
    isWorkspaceFileRef(ref) ||
    isGitDiffTileRef(ref) ||
    isSnapshotDiffTileRef(ref)
  );
}

/**
 * The mobile "Switch tab" bottom sheet (the screenshot-2 surface). A
 * drag-dismissable `vaul` drawer whose category bar mirrors the desktop
 * left-panel registry and whose content region shows the active category:
 * flat lists for Agents/Terminals/Artifacts (P2.2) and the embedded desktop
 * File-tree / Git-diff panel bodies (P2.3).
 *
 * Opened from the Phase-1 current-tile bar chevron. Only meaningful on phones -
 * it is mounted from `MobileEpicTileView`, which itself renders only under the
 * `useIsMobile()` canvas branch - and self-gates on `useIsMobile()` as defence.
 */
export function TabSwitcherSheet(props: TabSwitcherSheetProps) {
  const { epicId, tabId, open, onOpenChange } = props;
  const isMobile = useIsMobile();
  // The drawer content is portaled to <body>; re-assert the app's resolved
  // theme on it so `--popover` / `--background` (and the preset tokens) resolve
  // correctly inside the portal instead of falling back to the light :root.
  const { resolvedTheme, themePreset } = useResolvedTheme();
  const persistedCategory = useActiveLeftPanelId(tabId);
  const setActivePanelId = useLeftPanelStore((s) => s.setActivePanelId);
  const activeCategory = clampToSwitcherCategory(persistedCategory);

  const handleCategoryChange = useCallback(
    (value: string) => {
      // Persist through the SAME desktop left-panel store so mobile and desktop
      // stay in sync; ignore any value outside the curated set defensively.
      if (isSwitcherCategory(value)) setActivePanelId(tabId, value);
    },
    [setActivePanelId, tabId],
  );

  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Close-on-open for the embedded panel bodies. The flat lists close the sheet
  // explicitly (they own the open call), but the File-tree / Git-diff bodies
  // open a tile through their own internal navigation - which we do not fork -
  // so instead watch the shown tile. Close ONLY when the newly-shown tile is an
  // embed-originated kind (a file-tree tap -> `workspace-file`, a git-diff tap
  // -> `git-diff` / `snapshot-diff`). A background chat/terminal/artifact open
  // (agent handoff, remote-delete re-resolve, cross-window nav on the shared
  // canvas store) also changes the shown tile, but must NOT close the sheet
  // under the user mid-browse - those flat-list opens close via their own
  // `onClose` instead.
  const canvas = useEpicCanvas(tabId);
  const shownTile = useMemo(
    () => selectMobileTile(canvas)?.ref ?? null,
    [canvas],
  );
  const shownInstanceId = shownTile?.instanceId ?? null;
  const shownInstanceIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      shownInstanceIdRef.current = null;
      return;
    }
    const previous = shownInstanceIdRef.current;
    shownInstanceIdRef.current = shownInstanceId;
    if (previous === null || shownInstanceId === previous) return;
    if (shownTile !== null && isEmbedOriginatedTileRef(shownTile)) {
      onOpenChange(false);
    }
  }, [open, shownInstanceId, shownTile, onOpenChange]);

  if (!isMobile) return null;

  return (
    <Drawer direction="bottom" open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        data-mobile-shell-touch-scope=""
        data-testid="mobile-tab-switcher-sheet"
        data-theme={themePreset}
        className={cn(resolvedTheme === "dark" && "dark", "h-[70dvh]")}
      >
        <DrawerHeader className="pb-2">
          <DrawerTitle>Switch tab</DrawerTitle>
        </DrawerHeader>
        <Tabs
          value={activeCategory}
          onValueChange={handleCategoryChange}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="shrink-0 border-b border-canvas-border/70">
            <SwitcherCategoryTabs />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {MOBILE_SWITCHER_CATEGORY_DEFS.map((definition) => (
              <TabsContent
                key={definition.id}
                value={definition.id}
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <SwitcherCategoryBody
                  categoryId={definition.id}
                  epicId={epicId}
                  tabId={tabId}
                  onClose={handleClose}
                />
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </DrawerContent>
    </Drawer>
  );
}

interface SwitcherCategoryBodyProps {
  readonly categoryId: LeftPanelId;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * Content-region registry: flat lists (P2.2) for the row-per-item categories;
 * embedded desktop panel bodies (P2.3) for File tree + Git diff. The flat lists
 * call `onClose` on selection; the embeds rely on the sheet's active-tile
 * watcher.
 */
function SwitcherCategoryBody(props: SwitcherCategoryBodyProps) {
  const { categoryId, epicId, tabId, onClose } = props;
  switch (categoryId) {
    case "chats":
      return (
        <SwitcherAgentsList epicId={epicId} tabId={tabId} onClose={onClose} />
      );
    case "terminals":
      return (
        <SwitcherTerminalsList epicId={epicId} tabId={tabId} onClose={onClose} />
      );
    case "artifacts":
      return (
        <SwitcherArtifactsList epicId={epicId} tabId={tabId} onClose={onClose} />
      );
    case "file-tree":
      return (
        <Suspense fallback={<SwitcherEmbedFallback />}>
          <SwitcherPanelEmbed
            category="file-tree"
            epicId={epicId}
            tabId={tabId}
          />
        </Suspense>
      );
    case "git-diff":
      return (
        <Suspense fallback={<SwitcherEmbedFallback />}>
          <SwitcherPanelEmbed
            category="git-diff"
            epicId={epicId}
            tabId={tabId}
          />
        </Suspense>
      );
    default:
      return null;
  }
}

function SwitcherEmbedFallback() {
  return (
    <div className="flex min-h-24 flex-1 items-center justify-center p-6">
      <AgentSpinningDots
        className="size-4 text-muted-foreground"
        testId="switcher-embed-loading"
        variant="dots2"
      />
    </div>
  );
}
