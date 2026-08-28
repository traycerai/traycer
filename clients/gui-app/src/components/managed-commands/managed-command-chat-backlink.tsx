import { v4 as uuidv4 } from "uuid";
import { MessagesSquare } from "lucide-react";
import { displayTitle } from "@/lib/display-title";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findOpenTileInTab } from "@/stores/epics/canvas/canvas-selectors";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

export interface ManagedCommandChatBacklinkProps {
  readonly tabId: string;
  readonly epicId: string;
  /** The agent that created the command - the list record's `chatId`. */
  readonly chatId: string;
  readonly fallbackHostId: string;
  readonly testId: string;
  readonly className: string | undefined;
}

/**
 * The backlink every managed-command surface carries (`UI.md` §1): from a
 * command back to the agent that created it. Renders nothing when that agent
 * is not in this epic's projection - another user's private chat, or one not
 * yet hydrated - because there would be nothing to open.
 */
export function ManagedCommandChatBacklink(
  props: ManagedCommandChatBacklinkProps,
) {
  const { chatId, epicId, tabId } = props;
  const chat = useEpicStore((state) =>
    Object.hasOwn(state.chats.byId, chatId) ? state.chats.byId[chatId] : null,
  );
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const prepareSetActiveTileTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareSetActiveTileTabFocusTarget,
  );

  if (chat === null) return null;
  const label = displayTitle(chat.title, "agent");

  const open = () => {
    // The chat's OWN host when the projection knows it, else the surface's
    // bound host. Carried into both the lookup and the open, so a clone that
    // holds two tabs for one copied chat id activates the one this window
    // actually belongs to rather than whichever came first.
    const chatRef = makeOpenableNodeRef({
      id: chatId,
      instanceId: uuidv4(),
      type: "chat",
      name: label,
      hostId: chat.hostId ?? props.fallbackHostId,
    });
    const found = findOpenTileInTab(tabId, chatRef);
    if (found !== null) {
      navigateNested(epicId, tabId, () =>
        prepareSetActiveTileTabFocusTarget(
          tabId,
          found.paneId,
          found.instanceId,
        ),
      );
      return;
    }
    navigateNested(epicId, tabId, () =>
      prepareOpenTileInTabFocusTarget(tabId, chatRef),
    );
  };

  return (
    <TooltipWrapper
      label={`Open ${label}`}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        data-testid={props.testId}
        aria-label={`Open ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
        className={cn(
          "inline-flex min-w-0 items-center gap-1 text-ui-xs text-muted-foreground hover:text-foreground",
          props.className,
        )}
      >
        <MessagesSquare aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
    </TooltipWrapper>
  );
}
