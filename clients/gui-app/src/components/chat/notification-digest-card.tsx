import { ChevronRight } from "lucide-react";
import type {
  ChatNotificationDigestRow,
  ChatQueuedNotificationDigestItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const ENTITY_LABEL: Record<
  NonNullable<ChatNotificationDigestRow["entity"]>["kind"],
  string
> = {
  task: "Task",
  chat: "Chat",
  bot: "Bot",
};

/**
 * A queued notification digest (a `notification-digest` item on a personal
 * bot's chat): one line per row that needs the person, each led by what it
 * names, and the other rows folded beneath. The rows are the item's own, as
 * the bot will read them.
 */
export function NotificationDigestCard(props: {
  readonly item: ChatQueuedNotificationDigestItem;
}) {
  const { attention, recent, truncated } = props.item;
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 text-muted-foreground"
      data-testid="notification-digest-card"
    >
      {attention.length === 0 ? (
        <span>Nothing needs you</span>
      ) : (
        <ul className="flex min-w-0 flex-col gap-0.5">
          {attention.map((row) => (
            <NotificationDigestRowLine key={row.notificationId} row={row} />
          ))}
        </ul>
      )}
      {recent !== null && recent.length > 0 ? (
        <Collapsible className="min-w-0">
          <CollapsibleTrigger
            variant="quiet"
            className="group/digest-recent flex w-fit items-center text-ui-xs"
            data-testid="notification-digest-recent-toggle"
          >
            <ChevronRight
              className="size-3 shrink-0 transition-transform group-data-[state=open]/digest-recent:rotate-90"
              aria-hidden
            />
            {recent.length} more
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-0.5">
            <ul className="flex min-w-0 flex-col gap-0.5">
              {recent.map((row) => (
                <NotificationDigestRowLine key={row.notificationId} row={row} />
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {truncated ? (
        <span className="text-ui-xs">The rest follows in the next digest</span>
      ) : null}
    </div>
  );
}

function NotificationDigestRowLine(props: {
  readonly row: ChatNotificationDigestRow;
}) {
  const { row } = props;
  return (
    <li
      className="flex min-w-0 items-center gap-1"
      data-testid="notification-digest-row"
    >
      {row.entity === null ? null : (
        // Capped at half the row and cut, so a long task title never hides
        // the notification beside it.
        <Badge
          variant="muted"
          className="min-w-0 max-w-1/2"
          data-testid="notification-digest-entity"
        >
          <span className="truncate">
            {ENTITY_LABEL[row.entity.kind]}
            {row.entity.title === null ? null : `: ${row.entity.title}`}
          </span>
        </Badge>
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          row.read ? null : "text-foreground",
        )}
      >
        {row.title}
      </span>
    </li>
  );
}
