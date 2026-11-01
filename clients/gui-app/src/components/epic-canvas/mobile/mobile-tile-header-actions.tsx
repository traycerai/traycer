import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileTabOriginStore } from "@/stores/epics/mobile-tab-origin-store";

/**
 * The way back to the bot this task was opened from, in the current tile's
 * header. Nothing for a task opened any other way, or once that bot's tab is
 * gone. It is spent by being used: the bot's tab is where the person is then.
 */
export function MobileTileOriginCrumb(props: {
  readonly tabId: string;
}): ReactNode {
  const { tabId } = props;
  const botId = useMobileTabOriginStore((s) =>
    Object.hasOwn(s.botIdByTabId, tabId) ? s.botIdByTabId[tabId] : null,
  );
  const title = useBotTabsStore((s) =>
    botId !== null && Object.hasOwn(s.tabs, botId) ? s.tabs[botId].title : null,
  );
  if (botId === null || title === null) return null;
  return <OriginCrumbButton tabId={tabId} botId={botId} title={title} />;
}

function OriginCrumbButton(props: {
  readonly tabId: string;
  readonly botId: string;
  readonly title: string;
}): ReactNode {
  const { tabId, botId, title } = props;
  const navigate = useNavigate();
  const clear = useMobileTabOriginStore((s) => s.clear);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`Back to ${title}`}
      data-testid="mobile-tile-origin-crumb"
      className="min-w-0 max-w-[40%] shrink"
      onClick={() => {
        clear(tabId);
        navigateToTabIntent(navigate, botTabIntent(botId), undefined);
      }}
    >
      <ChevronLeft aria-hidden="true" />
      <span className="min-w-0 truncate">{title}</span>
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
