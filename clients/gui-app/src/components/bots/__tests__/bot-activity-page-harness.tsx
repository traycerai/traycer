/**
 * The component the Activity page's suites mount: the real page over the real
 * `useBotActiveTasks`, under the feed mode the notification session negotiated.
 */
import { type ReactNode } from "react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotNotificationSubscription,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import { BotActivityPage } from "@/components/bots/bot-activity-page";
import { useBotActiveTasks } from "@/hooks/bots/use-bot-active-tasks";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";

export const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const HOST_ID = "host-bound";

type HarnessProps = {
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly threads: ReadonlyArray<BotThreadSummary>;
  readonly boundHere: boolean;
  readonly notificationSubscriptions: ReadonlyArray<BotNotificationSubscription> | null;
};

/** The hook reads the feed mode from its ancestors, so the provider sits above the component that calls it. */
export function Harness(props: HarnessProps): ReactNode {
  return (
    <NotificationFeedModeContext.Provider value={mocks.state.feedMode}>
      <HarnessBody {...props} />
    </NotificationFeedModeContext.Provider>
  );
}

function HarnessBody(props: HarnessProps): ReactNode {
  const active = useBotActiveTasks(props.tasks, HOST_ID, true, BOT_ID);
  return (
    <BotActivityPage
      roomFresh
      botId={BOT_ID}
      hostId={HOST_ID}
      boundHere={props.boundHere}
      active={active}
      notificationSubscriptions={props.notificationSubscriptions}
      trunkChatId="bot-trunk"
      onOpenSession={mocks.openSession}
      resolveMember={() => null}
      threads={props.threads}
    />
  );
}
