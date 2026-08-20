import { ListTree } from "lucide-react";
import {
  useCallback,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { MinimapListCard } from "@/components/minimap/minimap-list-card";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { cn } from "@/lib/utils";
import {
  selectTileMinimapAdapter,
  useTileMinimapStore,
  type TileMinimapAdapter,
} from "@/stores/tile-minimap";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

const MINIMAP_BUTTON_LABEL = "Minimap";

function clampIndex(index: number, itemCount: number): number {
  return Math.max(0, Math.min(index, itemCount - 1));
}

export interface ContentMinimapButtonProps {
  readonly tileInstanceId: string;
}

/**
 * The phone tile bar's entry point into the tile's minimap.
 *
 * The edge rail beside the content is a hover affordance behind
 * `@media(pointer:fine)`, so on a phone it does not exist at all - and even on
 * a pointer device it is only findable by someone who already knows it is
 * there. This button is the same navigator behind an explicit target, which is
 * why it deliberately ignores the `hide` minimap setting: that setting turns
 * off ambient chrome floating over the content, and obeying it here would
 * leave the feature with no way in.
 *
 * Renders nothing for a tile with no navigable content (a terminal, a diff, a
 * chat with no turns yet), so the bar keeps its title-only shape there.
 */
export function ContentMinimapButton(
  props: ContentMinimapButtonProps,
): ReactNode {
  const adapter = useTileMinimapStore(
    selectTileMinimapAdapter(props.tileInstanceId),
  );
  if (adapter === null) return null;
  return <ContentMinimapDrawer adapter={adapter} />;
}

function ContentMinimapDrawer(props: {
  readonly adapter: TileMinimapAdapter;
}): ReactNode {
  const { adapter } = props;
  // Drawer content portals to <body>; re-assert the resolved theme so
  // `--popover` resolves inside the portal instead of the light `:root`
  // (same treatment as `TabSwitcherSheet` / `ComposerOptionsSheet`).
  const { resolvedTheme, themePreset } = useResolvedTheme();
  // Subscribed while closed too: the button hides itself on empty content, and
  // an unsubscribed bar would never learn that the first turn landed. The
  // adapter notifies on an outline or section change, not per scroll tick and
  // not per streaming token - see `useRegisterTileMinimap`.
  const snapshot = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot);
  const [open, setOpen] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const items = snapshot.items;
  const currentIndex = clampIndex(snapshot.currentIndex, items.length);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (next) setCursorIndex(currentIndex);
      setOpen(next);
    },
    [currentIndex],
  );

  // Tap to jump and close: the drawer covers the content it just scrolled, so
  // leaving it up would hide the landing.
  const handleSelect = useCallback(
    (index: number): void => {
      adapter.select(index);
      setOpen(false);
    },
    [adapter],
  );

  if (items.length === 0) return null;

  return (
    <Drawer direction="bottom" open={open} onOpenChange={handleOpenChange}>
      <DrawerTrigger asChild>
        <Button
          aria-expanded={open}
          aria-label={MINIMAP_BUTTON_LABEL}
          className="shrink-0"
          data-testid="content-minimap-button"
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ListTree className="size-4" />
        </Button>
      </DrawerTrigger>
      <DrawerContent
        data-mobile-shell-touch-scope=""
        data-testid="content-minimap-drawer"
        data-theme={themePreset}
        className={cn(resolvedTheme === "dark" && "dark", "max-h-[85dvh]")}
      >
        {/* The card renders its own visible heading; this is the a11y name. */}
        <DrawerTitle className="sr-only">{adapter.title}</DrawerTitle>
        {/* Mounted with the drawer, not with the bar: the card scrolls its
            current row into view on every change of it, and a closed drawer
            still lives in a portal - so leaving it mounted forces a document
            layout from a surface nobody is looking at, in the frames the
            content behind it is measuring itself. */}
        {open ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pt-1 pb-safe-bottom-gutter">
            <MinimapListCard
              className="max-h-none border-0 bg-transparent shadow-none"
              currentIndex={currentIndex}
              cursorIndex={clampIndex(cursorIndex, items.length)}
              items={items}
              onCursorIndexChange={setCursorIndex}
              onSelect={handleSelect}
              side="right"
              title={adapter.title}
            />
          </div>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}
