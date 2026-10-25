import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Hash, Plus } from "lucide-react";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import {
  TeamBotSetupDialog,
  type TeamBotSetupTarget,
} from "@/components/bots/team-bot-setup-dialog";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useTeamOnboardingGate } from "@/hooks/bots/use-team-onboarding-gate";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import {
  buildHomeBotsModel,
  type HomeBotsGroup,
} from "@/lib/home-bots/bots-model";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import {
  rebindUnreachableBotTab,
  useBotTabsStore,
} from "@/stores/bots/bot-tabs-store";
import { cn } from "@/lib/utils";

const EMPTY_ENVIRONMENTS: ReadonlyArray<EnvironmentDescriptor> = [];
const EMPTY_BOTS: ReadonlyArray<BotRecord> = [];
const NO_CHAT_IDS: ReadonlyArray<string> = [];

/**
 * Slack's sidebar for a bot tab (Tracy Bots, decision 41): every environment
 * the person belongs to is a section, every bot in it a channel, `# name`.
 * A channel with a reply the person has not read is bold, as Slack marks an
 * unread channel. The sections list channels and nothing else. A team's
 * header carries a + that opens the team's setup (`TeamBotSetupDialog`):
 * its onboarding while that is open, else the create form for one more bot,
 * so the environment is the section's and never a default. A team with no
 * bots says so once, with the same way in. The personal section has no +:
 * Tracy is the strip's fixed entry. While a team's onboarding locks its chat
 * (`teamOnboardingGate`), its channels do not open.
 *
 * Read through the tab's host: the lists are cloud-backed, so any host gives
 * the same answer. A channel opens that bot's tab, through this tab's host,
 * which asks where the bot is served and follows the answer.
 */
export function BotChannelSidebar(props: {
  readonly activeBotId: string;
  readonly hostId: string;
}): ReactNode {
  const { activeBotId, hostId } = props;
  const client = useTabHostClient();
  const environments = useEnvironmentListQuery(client, true);
  const bots = useBotListQuery(client, true);
  const connectable = useConnectableHostIds();
  const bindings = useHostEnvironmentBindings(connectable.hostIds, true);
  const environmentList = environments.data?.environments ?? EMPTY_ENVIRONMENTS;
  const botList = bots.data?.bots ?? EMPTY_BOTS;
  const mainBotIds = bots.data?.mainBotIds ?? null;
  const model = useMemo(
    () =>
      buildHomeBotsModel({
        environments: environmentList,
        bots: botList,
        mainBotIds,
      }),
    [botList, environmentList, mainBotIds],
  );
  const botIds = useMemo(() => botList.map((bot) => bot.botId), [botList]);
  // A bot's id is its container's, a shared cloud entity, so the
  // notification host answers for it.
  const indicators = useNotificationIndicators({
    hostId: null,
    epicIds: botIds,
    chatIds: NO_CHAT_IDS,
    enabled: botIds.length > 0,
  });
  const unreadBotIds = useMemo(() => {
    const unread = new Set<string>();
    for (const botId of botIds) {
      if (!Object.hasOwn(indicators.epics, botId)) continue;
      const state = indicators.epics[botId];
      if (state.unreadDone || state.unreadFailure) unread.add(botId);
    }
    return unread;
  }, [botIds, indicators.epics]);

  const navigate = useNavigate();
  const openBotTab = useBotTabsStore((s) => s.openBotTab);
  const [setup, setSetup] = useState<TeamBotSetupTarget | null>(null);
  const openChannel = (bot: BotRecord): void => {
    if (bot.botId === activeBotId) return;
    rebindUnreachableBotTab(
      bot.botId,
      hostId,
      connectable.resolved ? (id) => connectable.hostIds.includes(id) : null,
    );
    openBotTab({ botId: bot.botId, hostId, title: bot.title });
    navigateToTabIntent(navigate, botTabIntent(bot.botId), undefined);
  };

  return (
    <nav
      aria-label="Channels"
      data-testid="bot-channel-sidebar"
      className="flex min-h-0 flex-col gap-3 overflow-y-auto px-2 py-3"
    >
      {model.groups.map((group) => (
        <SidebarSection
          key={group.environmentId}
          group={group}
          activeBotId={activeBotId}
          unreadBotIds={unreadBotIds}
          onOpenChannel={openChannel}
          onSetUp={setSetup}
        />
      ))}
      <TeamBotSetupDialog
        team={setup}
        connectableHostIds={connectable.hostIds}
        environmentBindings={bindings}
        onClose={() => setSetup(null)}
      />
    </nav>
  );
}

function SidebarSection(props: {
  readonly group: HomeBotsGroup;
  readonly activeBotId: string;
  readonly unreadBotIds: ReadonlySet<string>;
  readonly onOpenChannel: (bot: BotRecord) => void;
  readonly onSetUp: (team: TeamBotSetupTarget) => void;
}): ReactNode {
  const { group, activeBotId, unreadBotIds, onOpenChannel, onSetUp } = props;
  const [collapsed, setCollapsed] = useState(false);
  const isTeam = group.canCreate && group.ownerKind === "organization";
  const client = useTabHostClient();
  const tabHostId = useTabHostId();
  const { gate } = useTeamOnboardingGate({
    client,
    hostId: tabHostId,
    environmentId: group.environmentId,
    isTeam,
    botCount: group.bots.length,
  });
  const locked = gate === "locked";
  const setUp = (event: MouseEvent<HTMLButtonElement>): void =>
    onSetUp({
      environmentId: group.environmentId,
      teamName: group.label,
      botCount: group.bots.length,
      opener: event.currentTarget,
    });
  // A collapsed section still lists the channel in view and the unread ones,
  // as Slack's does.
  const shown = collapsed
    ? group.bots.filter(
        (bot) => bot.botId === activeBotId || unreadBotIds.has(bot.botId),
      )
    : group.bots;
  return (
    <section
      aria-label={group.label}
      data-testid="bot-channel-section"
      data-environment-id={group.environmentId}
      className="flex flex-col gap-0.5"
    >
      <div className="group/section flex min-w-0 items-center gap-0.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-ui-sm font-medium text-muted-foreground transition-colors hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
        >
          {collapsed ? (
            <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{group.label}</span>
        </button>
        {isTeam ? (
          // Drawn on the header's hover and on keyboard focus, as the
          // section's own control rather than a row of it.
          <button
            type="button"
            aria-label={`Set up ${group.label}'s bots`}
            data-testid="bot-channel-section-add"
            onClick={setUp}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/6 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 group-hover/section:opacity-100"
          >
            <Plus className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {collapsed || !isTeam || group.bots.length > 0 ? null : (
        <button
          type="button"
          data-testid="bot-channel-section-set-up"
          onClick={setUp}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-ui-sm text-muted-foreground transition-colors hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
        >
          <Plus className="size-3.5 shrink-0" aria-hidden="true" />
          Set up your team's bots
        </button>
      )}
      <ul className="flex flex-col gap-0.5">
        {shown.map((bot) => (
          <li key={bot.botId}>
            <ChannelRow
              bot={bot}
              active={bot.botId === activeBotId}
              unread={unreadBotIds.has(bot.botId)}
              locked={locked}
              onOpen={() => onOpenChannel(bot)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChannelRow(props: {
  readonly bot: BotRecord;
  readonly active: boolean;
  readonly unread: boolean;
  readonly locked: boolean;
  readonly onOpen: () => void;
}): ReactNode {
  const { bot, active, unread, locked, onOpen } = props;
  return (
    <button
      type="button"
      disabled={locked}
      data-testid="bot-channel-row"
      data-bot-id={bot.botId}
      data-unread={unread ? "true" : "false"}
      aria-current={active ? "page" : undefined}
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-ui-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-foreground/6",
        unread && !active && "font-semibold text-foreground",
      )}
    >
      <Hash className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{bot.title}</span>
    </button>
  );
}
