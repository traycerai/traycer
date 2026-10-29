import { useMemo, useState, type ReactNode } from "react";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { Button } from "@/components/ui/button";
import {
  checkinRowsOf,
  RECENT_CHECKINS_SHOWN,
  type BotCheckinRow,
} from "@/lib/bots/bot-activity-model";
import { formatAbsoluteDateTime } from "@/lib/relative-time";

/**
 * A task's check-ins under its row on the bot's Activity page (Tracy Bots
 * T86), newest first: when each came in, the host that reported it and what
 * it said; a stretch no host reported is an amber row with why and when it
 * caught up. The newest few show, and "All N check-ins" the rest of the
 * week the host keeps. Nothing for a task with none.
 */
export function BotTaskCheckins(props: {
  readonly task: BotTaskEntry;
}): ReactNode {
  const rows = useMemo(() => checkinRowsOf(props.task), [props.task]);
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, RECENT_CHECKINS_SHOWN);
  return (
    <section
      aria-label="Check-ins"
      className="flex flex-col gap-0.5 border-l border-border/60 pl-2"
      data-testid="bot-task-checkins"
    >
      <ul className="flex flex-col gap-0.5">
        {shown.map((row) => (
          <li key={row.key}>
            <CheckinRow row={row} />
          </li>
        ))}
      </ul>
      {rows.length > RECENT_CHECKINS_SHOWN ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          data-testid="bot-task-checkins-all"
          aria-expanded={all}
          onClick={() => setAll((open) => !open)}
        >
          {all ? "Fewer check-ins" : `All ${rows.length} check-ins`}
        </Button>
      ) : null}
    </section>
  );
}

function CheckinRow(props: { readonly row: BotCheckinRow }): ReactNode {
  const { row } = props;
  if (row.kind === "missed") {
    return (
      <p
        data-testid="bot-task-checkin"
        data-kind="missed"
        className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-ui-xs text-warning-foreground"
      >
        <span className="tabular-nums">{formatAbsoluteDateTime(row.at)}</span>
        {" · Missed: no host reported"}
        {row.caughtUpAt === null
          ? null
          : ` · caught up ${formatAbsoluteDateTime(row.caughtUpAt)}`}
      </p>
    );
  }
  return (
    <p
      data-testid="bot-task-checkin"
      data-kind="received"
      className="flex min-w-0 flex-wrap gap-x-1.5 px-2 py-0.5 text-ui-xs text-muted-foreground"
    >
      <span className="tabular-nums">{formatAbsoluteDateTime(row.at)}</span>
      {row.hostName === null ? null : <span>· {row.hostName}</span>}
      <span className="text-foreground">· {row.said}</span>
    </p>
  );
}
