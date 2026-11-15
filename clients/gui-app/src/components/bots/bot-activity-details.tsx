import type { ReactNode } from "react";
import type { BotNotificationSubscription } from "@traycer/protocol/host/bot/schemas";

export function BotActivityDetails(props: {
  readonly subscriptions: ReadonlyArray<BotNotificationSubscription> | null;
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
          {props.subscriptions.map((subscription) => (
            <li
              key={
                subscription.target.kind === "trunk"
                  ? "trunk"
                  : subscription.target.threadId
              }
              className="flex flex-wrap gap-x-1 text-ui-xs"
            >
              <span>Watching notifications</span>
              <span aria-hidden>·</span>
              <span>
                {subscription.attentionOnly
                  ? "Needs attention only"
                  : "All notifications"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
