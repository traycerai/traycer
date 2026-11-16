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
          {props.subscriptions.map((subscription) => {
            const target = subscription.target;
            const thread =
              target.kind === "thread"
                ? props.threads?.find(
                    (item) => item.threadId === target.threadId,
                  )
                : undefined;
            const chatId =
              target.kind === "trunk"
                ? props.trunkChatId
                : thread?.sessionChatId;
            const threadId = target.kind === "thread" ? target.threadId : null;
            return (
              <li
                key={target.kind === "trunk" ? "trunk" : target.threadId}
                className="flex flex-wrap gap-x-1 text-ui-xs"
              >
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
