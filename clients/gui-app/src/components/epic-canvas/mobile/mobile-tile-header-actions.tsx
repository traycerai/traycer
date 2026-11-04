import type { ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MobileTileSelection } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { useOpenBotChannel } from "@/hooks/bots/use-open-bot-channel";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileTabOriginStore } from "@/stores/epics/mobile-tab-origin-store";
import { TRACY_TAB_LABEL } from "@/stores/tabs/kinds/tracy";

/**
 * The way back to the Tracy channel this task was opened from, in the current
 * tile's header. Nothing for a task opened any other way, or once that channel
 * or the surface is gone. It is spent by being used: the channel is where the
 * person is then.
 */
export function MobileTileOriginCrumb(props: {
  readonly tabId: string;
}): ReactNode {
  const { tabId } = props;
  const botId = useMobileTabOriginStore((s) =>
    Object.hasOwn(s.botIdByTabId, tabId) ? s.botIdByTabId[tabId] : null,
  );
  if (botId === null) return null;
  return <OriginCrumbButton tabId={tabId} botId={botId} />;
}

function OriginCrumbButton(props: {
  readonly tabId: string;
  readonly botId: string;
}): ReactNode {
  const { tabId, botId } = props;
  const openChannel = useOpenBotChannel();
  const clear = useMobileTabOriginStore((s) => s.clear);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`Back to ${TRACY_TAB_LABEL}`}
      data-testid="mobile-tile-origin-crumb"
      className="min-w-0 max-w-[40%] shrink"
      onClick={() => {
        clear(tabId);
        openChannel(botId, null);
      }}
    >
      <ChevronLeft aria-hidden="true" />
      <span className="min-w-0 truncate">{TRACY_TAB_LABEL}</span>
    </Button>
  );
}

/**
 * Back to one tile: the second one leaves the screen. It stays in the task's
 * list unless nobody asked to keep it, which is what the slot's store decides.
 */
export function MobileSecondaryTileClose(props: {
  readonly tabId: string;
}): ReactNode {
  const { tabId } = props;
  const setSecondary = useEpicCanvasStore((s) => s.setMobileSecondaryTile);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Close this side"
      data-testid="mobile-secondary-tile-close"
      className="shrink-0"
      onClick={() => setSecondary(tabId, null)}
    >
      <X aria-hidden="true" />
    </Button>
  );
}

/**
 * Back to one tile from the first tile's side: the second tile becomes the one
 * shown, in the first tile's place. The first stays in the task's list, as the
 * second does when its own side closes. Drawn only while two tiles show.
 */
export function MobilePrimaryTileClose(props: {
  readonly epicId: string;
  readonly tabId: string;
  /** The second tile, which takes the screen. */
  readonly secondary: MobileTileSelection;
}): ReactNode {
  const { epicId, tabId, secondary } = props;
  const navigateNested = useEpicNestedFocusNavigation();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Close this side"
      data-testid="mobile-primary-tile-close"
      className="shrink-0"
      onClick={() => {
        const store = useEpicCanvasStore.getState();
        // The second tile is the shown one before its slot clears, so the
        // clear keeps it: a transient slot is evicted only while it is not
        // what the first tile shows.
        navigateNested(epicId, tabId, () =>
          store.prepareSetActiveTileTabFocusTarget(
            tabId,
            secondary.paneId,
            secondary.ref.instanceId,
          ),
        );
        store.setMobileSecondaryTile(tabId, null);
      }}
    >
      <X aria-hidden="true" />
    </Button>
  );
}
