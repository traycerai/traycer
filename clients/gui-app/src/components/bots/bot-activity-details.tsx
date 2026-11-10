import { useMemo, type ReactNode } from "react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotNotificationSubscription,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import { useBotTurnLocateQuery } from "@/hooks/bots/use-bot-turn-locate-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { describeSeconds } from "@/lib/bots/bot-trunk-model";
import { formatAbsoluteDateTime } from "@/lib/relative-time";
import type {
  BotSessionOpen,
  BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";

const NO_IDS: ReadonlyArray<string> = [];

export function BotActivityDetails(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly subscriptions: ReadonlyArray<BotNotificationSubscription> | null;
  readonly onOpenTurn: BotTurnOpen;
  readonly trunkChatId: string;
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly onOpenSession: BotSessionOpen;
}): ReactNode {
  const turns = useMemo(
    () =>
      props.tasks.flatMap((task) =>
        (task.checkins ?? []).flatMap((entry) =>
          entry.kind === "received" && entry.turn !== null ? [entry.turn] : [],
        ),
      ),
    [props.tasks],
  );
  const client = useTabHostClient();
  const located = useBotTurnLocateQuery({
    client,
    hostId: props.hostId,
    botId: props.botId,
    messageIds: NO_IDS,
    requestIds: NO_IDS,
    turns,
  });
  const tasks = props.tasks.filter(
    (task) =>
      (task.checkins?.length ?? 0) > 0 ||
      task.lastCheckin !== null ||
      task.lastCheckinAt !== null ||
      (task.state === "tracking" && task.cadence.kind !== "none"),
  );
  return (
    <>
      <section
        className="mt-4 flex flex-col gap-1"
        aria-label="Tasks with check-ins"
      >
        <h3 className="text-ui-xs tracking-[0.08em] text-muted-foreground uppercase">
          Tasks with check-ins
        </h3>
        {tasks.length === 0 ? (
          <p className="text-ui-xs text-muted-foreground">
            {props.tasks.some((task) => task.checkins === null)
              ? "Check-in history unavailable"
              : "No tasks with check-ins"}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((task) => (
              <li key={task.taskId} className="text-ui-xs">
                <p className="font-medium">{task.label ?? task.taskId}</p>
                {(task.checkins === null || task.checkins.length === 0) &&
                  task.lastCheckin !== null && (
                    <p className="text-muted-foreground">
                      Check-in received ·{" "}
                      {formatAbsoluteDateTime(task.lastCheckin.deliveredAt)}
                    </p>
                  )}
                {task.checkins === null && task.lastCheckin === null && (
                  <p className="text-muted-foreground">
                    Check-in history unavailable
                  </p>
                )}
                {task.checkins !== null &&
                  task.checkins.length === 0 &&
                  task.lastCheckin === null && (
                    <p className="text-muted-foreground">No check-ins yet</p>
                  )}
                {task.checkins !== null && task.checkins.length > 0 && (
                  <ul>
                    {task.checkins.map((entry) => {
                      const key = entry.kind === "received" ? entry.turn : null;
                      const ref =
                        key === null
                          ? undefined
                          : located.data?.turns.find(
                              (turn) =>
                                turn.chatId === key.chatId &&
                                turn.turnIds.includes(key.turnId),
                            );
                      return (
                        <li
                          key={
                            entry.kind === "received"
                              ? `received-${entry.receivedAt}-${entry.hostId}`
                              : `missed-${entry.dueAt}`
                          }
                          className="text-muted-foreground"
                        >
                          {entry.kind === "received" ? (
                            <>
                              Check-in received ·{" "}
                              {formatAbsoluteDateTime(entry.receivedAt)} ·{" "}
                              {entry.hostName} ·{" "}
                              {entry.outcome.replaceAll("-", " ")}
                            </>
                          ) : (
                            <>
                              Check-in missed ·{" "}
                              {formatAbsoluteDateTime(entry.dueAt)}
                              {entry.caughtUpAt === null
                                ? null
                                : ` · caught up ${formatAbsoluteDateTime(entry.caughtUpAt)}`}
                            </>
                          )}
                          {ref === undefined ? null : (
                            <>
                              {" "}
                              ·{" "}
                              <button
                                type="button"
                                className="text-foreground underline"
                                onClick={() => props.onOpenTurn(ref, null)}
                              >
                                Open check-in
                              </button>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section
        className="mt-4 flex flex-col gap-1"
        aria-label="Notification subscriptions"
      >
        <h3 className="text-ui-xs tracking-[0.08em] text-muted-foreground uppercase">
          Notification subscriptions
        </h3>
        {props.subscriptions === null && (
          <p className="text-ui-xs text-muted-foreground">
            Subscriptions unavailable
          </p>
        )}
        {props.subscriptions !== null && props.subscriptions.length === 0 && (
          <p className="text-ui-xs text-muted-foreground">
            No notification subscriptions
          </p>
        )}
        {props.subscriptions !== null && props.subscriptions.length > 0 && (
          <ul className="flex flex-col gap-1">
            {props.subscriptions.map((subscription) => {
              const target = subscription.target;
              const thread =
                target.kind === "thread"
                  ? props.threads?.find(
                      (item) => item.threadId === target.threadId,
                    )
                  : undefined;
              const chatId =
                subscription.target.kind === "trunk"
                  ? props.trunkChatId
                  : thread?.sessionChatId;
              const threadId =
                subscription.target.kind === "thread"
                  ? subscription.target.threadId
                  : null;
              return (
                <li
                  key={
                    subscription.target.kind === "trunk"
                      ? "trunk"
                      : subscription.target.threadId
                  }
                  className="flex flex-wrap gap-x-2 text-ui-xs"
                >
                  <span>
                    {subscription.target.kind === "trunk"
                      ? "Trunk"
                      : `Thread: ${thread?.anchor?.excerpt ?? subscription.target.threadId}`}
                  </span>
                  <span>
                    {subscription.attentionOnly
                      ? "Attention only"
                      : "All notifications"}
                  </span>
                  <span className="text-muted-foreground">
                    {subscription.everySeconds === null
                      ? "Each burst"
                      : `Every ${describeSeconds(subscription.everySeconds)}`}
                  </span>
                  {chatId === undefined ? null : (
                    <button
                      type="button"
                      className="underline"
                      onClick={() =>
                        props.onOpenSession({
                          chatId,
                          threadId,
                          messageId: null,
                          sendPostId: null,
                        })
                      }
                    >
                      Open session
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
