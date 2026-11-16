import type { ReactNode } from "react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotNotificationSubscription } from "@traycer/protocol/host/bot/schemas";
import type { BotSessionOpen } from "@/stores/bots/bot-open-thread-store";

export function BotActivityDetails(props: {
  readonly subscriptions: ReadonlyArray<BotNotificationSubscription> | null;
  readonly roomFresh: boolean;
  readonly trunkChatId: string;
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly onOpenSession: BotSessionOpen;
}): ReactNode {
  if (props.subscriptions !== null && props.subscriptions.length === 0)
    return null;
  const destinations =
    props.subscriptions?.map((subscription, index) => {
      const target = subscription.target;
      const thread =
        target.kind === "thread"
          ? props.threads?.find((item) => item.threadId === target.threadId)
          : undefined;
      return {
        subscription,
        label:
          target.kind === "trunk"
            ? "Channel"
            : (thread?.anchor?.excerpt ?? `Thread ${String(index + 1)}`),
        chatId:
          target.kind === "trunk" ? props.trunkChatId : thread?.sessionChatId,
        threadId: target.kind === "thread" ? target.threadId : null,
      };
    }) ?? [];
  const labelCounts = new Map<string, number>();
  for (const destination of destinations) {
    labelCounts.set(
      destination.label,
      (labelCounts.get(destination.label) ?? 0) + 1,
    );
  }
  const usedLabels = new Set(
    destinations.map((destination) => destination.label),
  );
  return (
    <section
      className="mt-4 flex flex-col gap-1"
      aria-label="Notification subscriptions"
    >
      <h3 className="text-ui-xs tracking-[0.08em] text-muted-foreground uppercase">
        Notification subscriptions
      </h3>
      {props.subscriptions === null ? (
        <p className="text-ui-xs text-muted-foreground">
          Subscriptions unavailable
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {destinations.map((destination, index) => {
            const { subscription, chatId, threadId } = destination;
            const target = subscription.target;
            let label = destination.label;
            if ((labelCounts.get(destination.label) ?? 0) > 1) {
              let suffix = index + 1;
              do {
                label = `${destination.label} (${String(suffix)})`;
                suffix += 1;
              } while (usedLabels.has(label));
              usedLabels.add(label);
            }
            return (
              <li
                key={target.kind === "trunk" ? "trunk" : target.threadId}
                className="flex flex-wrap gap-x-1 text-ui-xs"
              >
                <span>{label}</span>
                <span aria-hidden>·</span>
                <span>
                  {props.roomFresh
                    ? "Watching notifications"
                    : "Notifications: status unknown"}
                </span>
                <span aria-hidden>·</span>
                <span>
                  {subscription.attentionOnly
                    ? "Needs attention only"
                    : "All notifications"}
                </span>
                {chatId === undefined ? null : (
                  <button
                    type="button"
                    className="underline"
                    aria-label={`Open transcript: ${label}`}
                    onClick={() =>
                      props.onOpenSession({
                        chatId,
                        threadId,
                        messageId: null,
                        sendPostId: null,
                      })
                    }
                  >
                    Open transcript
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
