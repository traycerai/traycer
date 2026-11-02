import type { ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOpenBotChannel } from "@/hooks/bots/use-open-bot-channel";
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
