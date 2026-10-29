import { useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import { Badge } from "@/components/ui/badge";
import { MainBotBadge } from "@/components/bots/main-bot-badge";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useBotSubscription } from "@/hooks/bots/use-bot-subscription";
import { botWorkingOf, liveActivityOf } from "@/hooks/bots/use-bot-activity";
import {
  rebindUnreachableBotTab,
  useBotTabsStore,
} from "@/stores/bots/bot-tabs-store";
import {
  buildHomeBotRow,
  homeBotState,
  type HomeBotState,
} from "@/lib/home-bots/bots-model";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import type { TeamSetup } from "@/hooks/bots/use-team-setups";

/**
 * The reader's own hosts, and which of them this client can dial now.
 * `connectableResolved` is false until the directory has answered: until
 * then an empty `connectableHostIds` means "not known yet", not "none".
 */
export interface HomeBotHostReach {
  readonly directoryHostIds: ReadonlySet<string>;
  readonly connectableHostIds: ReadonlySet<string>;
  readonly connectableResolved: boolean;
  /** The reader's own hosts the registry calls `personal`; `null` until the
   * registry has answered. */
  readonly personalHostIds: ReadonlySet<string> | null;
}

const STATE_LABELS: Readonly<Record<HomeBotState, string>> = {
  working: "Working",
  idle: "Idle",
  paused: "Paused",
};

const STATE_BADGE_VARIANTS = {
  working: "success",
  idle: "muted",
  paused: "warning",
} as const satisfies Record<HomeBotState, "success" | "muted" | "warning">;

/**
 * One bot on Home. The row subscribes to its own `bot.subscribe` through the
 * app-wide host and renders whatever the snapshot says as it arrives: the
 * title, its state, the tasks it spun and still runs, and the
 * open-request HINT. The hint is shown only when it is above zero, because
 * the conversation's rows, not this number, decide what is open.
 *
 * The row never names the machine the bot runs on: it says working, idle or
 * paused (`homeBotState`), working while the snapshot's activity has the
 * trunk or any thread replying. Idle says the bot's state is known, so with
 * no reading of it (no snapshot, no host has written the trunk, or a stream
 * closed for good, whose last reading nothing will move) the row says
 * nothing rather than idle. Opening it opens the tab through this
 * window's host, which asks `bot.open` where the bot is served and follows
 * the answer.
 */
export function HomeBotRow(props: {
  readonly bot: BotRecord;
  readonly hostReach: HomeBotHostReach;
  /** The machines of the bot's environment the reader may see beyond their
   * own; `null` while a team environment's list has not answered. */
  readonly environmentHostIds: ReadonlySet<string> | null;
  /** The bot's environment's owner kind; `null` when it is not listed. */
  readonly environmentOwnerKind: EnvironmentDescriptor["ownerKind"] | null;
  /** Who made the bot ("Created by …"), or null to say nothing. */
  readonly createdBy: string | null;
  /** Whether the bot is its environment's main bot (decision 30). */
  readonly isMain: boolean;
}): ReactNode {
  const {
    bot,
    hostReach,
    environmentHostIds,
    environmentOwnerKind,
    createdBy,
    isMain,
  } = props;
  const hostId = useEffectiveHostId();
  const subscription = useBotSubscription({
    hostId,
    botId: bot.botId,
    enabled: hostId !== null,
  });
  const row = useMemo(
    () => buildHomeBotRow(bot, subscription.snapshot),
    [bot, subscription.snapshot],
  );
  const working = botWorkingOf(liveActivityOf(subscription));
  const openTab = useOpenHomeBotTab(hostReach);
  const reading = homeBotState({
    working: working === true,
    boundHostId: row.boundHostId,
    directoryHostIds: hostReach.directoryHostIds,
    connectableHostIds: hostReach.connectableHostIds,
    connectableResolved: hostReach.connectableResolved,
    environmentHostIds,
    environmentOwnerKind,
    personalHostIds: hostReach.personalHostIds,
  });
  const state = reading === "idle" && working === null ? null : reading;
  const openRequests = row.openRequestCount ?? 0;

  return (
    <button
      type="button"
      data-testid="home-bot-row"
      data-bot-id={row.botId}
      disabled={openTab === null}
      className="group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
      onClick={() => openTab?.(row.botId, row.title)}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/6 text-muted-foreground">
        <Bot className="size-4" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-ui-sm text-foreground">
            {row.title}
          </span>
          {isMain ? <MainBotBadge testId="home-bot-main" tone="muted" /> : null}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-xs text-muted-foreground">
          {state === null ? null : (
            <Badge
              variant={STATE_BADGE_VARIANTS[state]}
              size="xs"
              data-testid="home-bot-state"
              data-state={state}
            >
              {STATE_LABELS[state]}
            </Badge>
          )}
          {row.tasksSpun === null ? null : (
            <span data-testid="home-bot-tasks">
              {row.tasksSpun === 1 ? "1 task" : `${row.tasksSpun} tasks`}
            </span>
          )}
          {createdBy === null ? null : (
            <span data-testid="home-bot-created-by" className="truncate">
              {createdBy}
            </span>
          )}
        </span>
      </span>
      {openRequests > 0 ? (
        <Badge variant="warning" size="xs" data-testid="home-bot-open-requests">
          {openRequests === 1 ? "1 open" : `${openRequests} open`}
        </Badge>
      ) : null}
    </button>
  );
}

/**
 * A team's main bot still to be set up (`useTeamSetups`), on Home where its
 * team's card has no bot yet: the same entry as the channel sidebar's row,
 * marked as needing a host, opening the bot's tab, which shows the channel
 * where the team is set up.
 */
export function HomeSetupBotRow(props: {
  readonly setup: TeamSetup;
  readonly hostReach: HomeBotHostReach;
}): ReactNode {
  const { setup } = props;
  const openTab = useOpenHomeBotTab(props.hostReach);
  return (
    <button
      type="button"
      data-testid="home-bot-setup-row"
      data-bot-id={setup.botId}
      disabled={openTab === null}
      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
      onClick={() => openTab?.(setup.botId, setup.title)}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/6 text-muted-foreground">
        <Bot className="size-4" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-ui-sm text-foreground">
          {setup.title}
        </span>
        <MainBotBadge testId="home-bot-setup-row-main" tone="muted" />
      </span>
      <Badge
        variant="muted"
        size="xs"
        data-testid="home-bot-setup-row-needs-host"
      >
        Needs a host
      </Badge>
    </button>
  );
}

/**
 * Opens a bot's tab from Home through this window's host, first moving a tab
 * left on a host this client can no longer dial back to it; `null` while the
 * window has no host.
 */
function useOpenHomeBotTab(
  hostReach: HomeBotHostReach,
): ((botId: string, title: string) => void) | null {
  const hostId = useEffectiveHostId();
  const navigate = useNavigate();
  const openBotTab = useBotTabsStore((s) => s.openBotTab);
  if (hostId === null) return null;
  return (botId, title) => {
    rebindUnreachableBotTab(
      botId,
      hostId,
      hostReach.connectableResolved
        ? (id) => hostReach.connectableHostIds.has(id)
        : null,
    );
    openBotTab({ botId, hostId, title });
    navigateToTabIntent(navigate, botTabIntent(botId), undefined);
  };
}
