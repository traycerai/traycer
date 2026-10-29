import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { BotTurnRef } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotCheckinTurn,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import { Button } from "@/components/ui/button";
import { useBotTurnLocateQuery } from "@/hooks/bots/use-bot-turn-locate-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  checkinRowsOf,
  RECENT_CHECKINS_SHOWN,
  type BotCheckinRow,
} from "@/lib/bots/bot-activity-model";
import { turnReceiptLabel } from "@/lib/bots/bot-turn-receipt";
import { formatAbsoluteDateTime } from "@/lib/relative-time";
import type { BotOpenTurn } from "@/stores/bots/bot-open-thread-store";

const NO_IDS: ReadonlyArray<string> = [];

/**
 * A task's check-ins under its row on the bot's Activity page (Tracy Bots
 * T86), newest first: when each came in, the host that reported it and what
 * it said; a stretch no host reported is an amber row with why and when it
 * caught up. The newest few show, and "All N check-ins" the rest of the
 * week the host keeps. A check-in whose turn the bot's host still keeps
 * links to it: the turn opens beside the channel, in Messages. Nothing for a
 * task with none.
 */
export function BotTaskCheckins(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly task: BotTaskEntry;
  /** Opens a check-in's turn beside the channel. */
  readonly onOpenTurn: (open: BotOpenTurn) => void;
}): ReactNode {
  const { botId, hostId, task, onOpenTurn } = props;
  const rows = useMemo(() => checkinRowsOf(task), [task]);
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, RECENT_CHECKINS_SHOWN);
  const turns = useMemo(
    () =>
      shown.flatMap((row) =>
        row.kind === "received" && row.turn !== null ? [row.turn] : [],
      ),
    [shown],
  );
  const client = useTabHostClient();
  const located = useBotTurnLocateQuery({
    client,
    hostId,
    botId,
    messageIds: NO_IDS,
    requestIds: NO_IDS,
    turns,
  });
  const refOf = (turn: BotCheckinTurn): BotTurnRef | null =>
    located.data?.turns.find(
      (ref) => ref.chatId === turn.chatId && ref.turnIds.includes(turn.turnId),
    ) ?? null;
  if (rows.length === 0) return null;
  return (
    <section
      aria-label="Check-ins"
      className="flex flex-col gap-0.5 border-l border-border/60 pl-2"
      data-testid="bot-task-checkins"
    >
      <ul className="flex flex-col gap-0.5">
        {shown.map((row) => (
          <li key={row.key}>
            <CheckinRow
              row={row}
              turnRef={
                row.kind === "received" && row.turn !== null
                  ? refOf(row.turn)
                  : null
              }
              onOpenTurn={onOpenTurn}
            />
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

function CheckinRow(props: {
  readonly row: BotCheckinRow;
  /** The check-in's turn as the bot's host keeps it; `null` for none. */
  readonly turnRef: BotTurnRef | null;
  readonly onOpenTurn: (open: BotOpenTurn) => void;
}): ReactNode {
  const { row, turnRef, onOpenTurn } = props;
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
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 px-2 py-0.5 text-ui-xs text-muted-foreground"
    >
      <span className="tabular-nums">{formatAbsoluteDateTime(row.at)}</span>
      {row.hostName === null ? null : <span>· {row.hostName}</span>}
      <span className="text-foreground">· {row.said}</span>
      {turnRef === null ? null : (
        <Button
          type="button"
          variant="link"
          size="xs"
          data-testid="bot-task-checkin-turn"
          onClick={() =>
            onOpenTurn({ ref: turnRef, question: null, back: null })
          }
        >
          {(turnRef.summary === null ? null : turnReceiptLabel(turnRef)) ??
            "Open the turn"}
          <ChevronRight aria-hidden="true" />
        </Button>
      )}
    </p>
  );
}
