import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisVertical, ExternalLink, Plus } from "lucide-react";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import { NamedBotAvatar } from "@/components/bots/bot-avatars";
import { MainBotBadge } from "@/components/bots/main-bot-badge";
import { BotSettingsRefusal } from "@/components/bots/bot-settings-group";
import {
  NewBotDialog,
  type NewBotTarget,
} from "@/components/bots/new-bot-dialog";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDashboardPageOpener } from "@/components/settings/host-scope/use-dashboard-page-opener";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useEnvironmentSetMainBotMutation } from "@/hooks/bots/use-environment-set-main-bot-mutation";
import { useTeamSetups, type TeamSetup } from "@/hooks/bots/use-team-setups";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useRereadEnvironmentListOnFocus } from "@/hooks/bots/use-reread-environment-list-on-focus";
import { useHostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { useBotChannelMuted } from "@/hooks/bots/use-bot-notification-level";
import { useBotChannelBold } from "@/hooks/bots/use-bot-read-cursor";
import { BotMutedGlyph } from "@/components/bots/bot-muted-glyph";
import { UnreadCountBadge } from "@/components/notifications/unread-count-badge";
import { indicatorHasUnread } from "@/stores/notifications/notification-indicator-state";
import {
  buildHomeBotsModel,
  type HomeBotsGroup,
} from "@/lib/home-bots/bots-model";
import {
  createTeamDashboardUrl,
  hasNoTeamEnvironment,
} from "@/lib/home-bots/create-team-dashboard";
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
const SIDEBAR_ACTION_ROW_CLASS =
  "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-ui-sm text-muted-foreground transition-colors hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2";

/**
 * Slack's sidebar for a bot tab (Tracy Bots, decision 41): every environment
 * the person belongs to is a section, every bot in it a channel, drawn as
 * the bot's picture and name. A channel with a reply the person has not
 * read is bold and carries how many, right-aligned, as Slack marks an unread
 * channel. The sections list
 * channels and nothing else. A team's main bot is its channel from the
 * moment the team exists (T67): while the bot is still to be set up
 * (`useTeamSetups`) its row stands in the team's section, marked as needing
 * a host, and opens the channel where the team is set up. The + on a team's
 * header opens the team's main bot; on the person's own section it opens the
 * create form for one more bot there (`NewBotDialog`), which an empty
 * personal section offers once too. With no team at all, "Create a team"
 * stands where a team's section would, opening the dashboard page where a
 * team is made. The row of a bot that is not its environment's main bot,
 * where the environment has one and the tab's host can write it, has a menu
 * (its ⋮ and its context menu) whose "Make main" hands the star over, with no
 * confirmation since making another bot main hands it back; a refusal is
 * stated under the row.
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
  useRereadEnvironmentListOnFocus(true);
  const bots = useBotListQuery(client, true);
  const connectable = useConnectableHostIds();
  const bindings = useHostEnvironmentBindings(connectable.hostIds, true);
  const environmentList = environments.data?.environments ?? EMPTY_ENVIRONMENTS;
  const noTeam = hasNoTeamEnvironment(environments.data?.environments);
  const botList = bots.data?.bots ?? EMPTY_BOTS;
  const mainBotIds = bots.data?.mainBotIds ?? null;
  const canSetMainBot =
    useHostMethodSupport(hostId, "environment.setMainBot") === true;
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
  const unreadByBotId = useMemo(() => {
    // A channel with something unread, by how many; `null` where the host
    // does not count.
    const unread = new Map<string, number | null>();
    for (const botId of botIds) {
      if (!Object.hasOwn(indicators.epics, botId)) continue;
      const state = indicators.epics[botId];
      if (indicatorHasUnread(state)) {
        unread.set(botId, state.unreadCount);
      }
    }
    return unread;
  }, [botIds, indicators.epics]);

  const teamSetups = useTeamSetups({
    client,
    hostId,
    groups:
      environments.data === undefined || bots.data === undefined
        ? null
        : model.groups,
  });

  const navigate = useNavigate();
  const openBotTab = useBotTabsStore((s) => s.openBotTab);
  const [newBot, setNewBot] = useState<NewBotTarget | null>(null);
  const openChannel = (channel: SidebarChannel): void => {
    if (channel.botId === activeBotId) return;
    rebindUnreachableBotTab(
      channel.botId,
      hostId,
      connectable.resolved ? (id) => connectable.hostIds.includes(id) : null,
    );
    openBotTab({ botId: channel.botId, hostId, title: channel.title });
    navigateToTabIntent(navigate, botTabIntent(channel.botId), undefined);
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
          unreadByBotId={unreadByBotId}
          canSetMainBot={canSetMainBot}
          setup={
            teamSetups.setups.find(
              (setup) => setup.environmentId === group.environmentId,
            ) ?? null
          }
          hostId={hostId}
          onOpenChannel={openChannel}
          onNewBot={setNewBot}
        />
      ))}
      {noTeam ? <CreateTeamRow /> : null}
      <NewBotDialog
        target={newBot}
        connectableHostIds={connectable.hostIds}
        environmentBindings={bindings}
        onClose={() => setNewBot(null)}
      />
    </nav>
  );
}

/** A channel the sidebar opens: a listed bot, or a team's main bot still to be set up. */
type SidebarChannel = { readonly botId: string; readonly title: string };

function SidebarSection(props: {
  readonly group: HomeBotsGroup;
  readonly activeBotId: string;
  readonly unreadByBotId: ReadonlyMap<string, number | null>;
  /** Whether the tab's host can make another bot main. */
  readonly canSetMainBot: boolean;
  /** The team's main bot while it is still to be set up; `null` otherwise. */
  readonly setup: TeamSetup | null;
  /** The tab's host, which reads each channel's level. */
  readonly hostId: string;
  readonly onOpenChannel: (channel: SidebarChannel) => void;
  readonly onNewBot: (target: NewBotTarget) => void;
}): ReactNode {
  const { group, activeBotId, unreadByBotId, setup, hostId, onOpenChannel } =
    props;
  const isTeam = group.canCreate && group.ownerKind === "organization";
  const isPersonal = group.canCreate && group.ownerKind === "user";
  const newBot = (event: MouseEvent<HTMLButtonElement>): void =>
    props.onNewBot({
      environmentId: group.environmentId,
      environmentLabel: group.label,
      opener: event.currentTarget,
    });
  const main = isTeam ? teamMainChannelOf(group, setup) : null;
  return (
    <section
      aria-label={group.label}
      data-testid="bot-channel-section"
      data-environment-id={group.environmentId}
      className="flex flex-col gap-0.5"
    >
      <div className="group/section flex min-w-0 items-center gap-0.5">
        <span className="min-w-0 flex-1 truncate px-1.5 py-1 text-ui-sm font-medium text-muted-foreground">
          {group.label}
        </span>
        {main !== null || isPersonal ? (
          // Drawn on the header's hover and on keyboard focus, as the
          // section's own control rather than a row of it; always drawn on a
          // touch screen, which has no hover.
          <button
            type="button"
            aria-label={main === null ? "New bot" : `Open ${main.title}`}
            data-testid="bot-channel-section-add"
            onClick={(event) => {
              if (main === null) newBot(event);
              else onOpenChannel(main);
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/6 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 group-hover/section:opacity-100 pointer-coarse:opacity-100"
          >
            <Plus className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {!isPersonal || group.bots.length > 0 ? null : (
        <button
          type="button"
          data-testid="bot-channel-section-set-up"
          onClick={newBot}
          className={SIDEBAR_ACTION_ROW_CLASS}
        >
          <Plus className="size-3.5 shrink-0" aria-hidden="true" />
          New bot
        </button>
      )}
      <ul className="flex flex-col gap-0.5">
        {group.bots.map((bot) => {
          const row = (
            <ChannelRow
              bot={bot}
              isMain={bot.botId === group.mainBotId}
              active={bot.botId === activeBotId}
              unread={unreadByBotId.has(bot.botId)}
              unreadCount={unreadByBotId.get(bot.botId) ?? null}
              hostId={hostId}
              onOpen={() => onOpenChannel(bot)}
            />
          );
          const canMakeMain =
            props.canSetMainBot &&
            group.mainBotId !== null &&
            bot.botId !== group.mainBotId;
          return (
            <li key={bot.botId}>
              {canMakeMain ? (
                <MakeMainChannelRow bot={bot}>{row}</MakeMainChannelRow>
              ) : (
                row
              )}
            </li>
          );
        })}
        {setup === null ? null : (
          <li>
            <SetupChannelRow
              setup={setup}
              active={setup.botId === activeBotId}
              onOpen={() => onOpenChannel(setup)}
            />
          </li>
        )}
      </ul>
    </section>
  );
}

/**
 * The channel a team's + opens: its main bot, the one still to be set up
 * while it is, else its first bot where the list names no main bot (a host
 * that predates the field). `null` for a team with neither.
 */
function teamMainChannelOf(
  group: HomeBotsGroup,
  setup: TeamSetup | null,
): SidebarChannel | null {
  if (setup !== null) return setup;
  return (
    group.bots.find((bot) => bot.botId === group.mainBotId) ??
    group.bots.at(0) ??
    null
  );
}

/**
 * A team's main bot while it is still to be set up: its picture and name,
 * marked as the main bot and as needing a host the team can use, opening the
 * channel where the team is set up.
 */
function SetupChannelRow(props: {
  readonly setup: TeamSetup;
  readonly active: boolean;
  readonly onOpen: () => void;
}): ReactNode {
  const { setup, active } = props;
  return (
    <button
      type="button"
      data-testid="bot-channel-setup-row"
      data-bot-id={setup.botId}
      aria-current={active ? "page" : undefined}
      onClick={props.onOpen}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-ui-sm transition-colors focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
        active
          ? "bg-accent text-accent-foreground"
          : "text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground",
      )}
    >
      <NamedBotAvatar botId={setup.botId} title={setup.title} size="sm" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate">{setup.title}</span>
        <MainBotBadge
          testId="bot-channel-setup-row-main"
          tone={active ? "current" : "muted"}
        />
      </span>
      <Badge
        variant="muted"
        size="xs"
        data-testid="bot-channel-setup-row-needs-host"
      >
        Needs a host
      </Badge>
    </button>
  );
}

function ChannelRow(props: {
  readonly bot: BotRecord;
  readonly isMain: boolean;
  readonly active: boolean;
  readonly unread: boolean;
  /** Drawn right-aligned; `null` where the host does not count. */
  readonly unreadCount: number | null;
  readonly hostId: string;
  readonly onOpen: () => void;
}): ReactNode {
  const { bot, isMain, active, unread, unreadCount, hostId, onOpen } = props;
  const client = useTabHostClient();
  const muted = useBotChannelMuted(
    client,
    hostId,
    bot.botId,
    bot.appConversationChatId,
  );
  // Bold is the read cursor's where the host keeps one (decision 139): a
  // channel with new posts at Mentions level is bold with no count.
  const bold =
    useBotChannelBold(client, hostId, bot.botId, bot.appConversationChatId) ??
    unread;
  return (
    <button
      type="button"
      data-testid="bot-channel-row"
      data-bot-id={bot.botId}
      data-unread={bold ? "true" : "false"}
      aria-current={active ? "page" : undefined}
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-ui-sm transition-colors focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
        // The task panel's row arms (`chatRowClassName`), so the selected
        // channel is the same quiet highlight as the selected agent.
        active
          ? "bg-accent text-accent-foreground"
          : "text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground",
        bold && !active && "font-semibold text-foreground",
      )}
    >
      <NamedBotAvatar botId={bot.botId} title={bot.title} size="sm" />
      {/* The star sits on the name, before any count. */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate">{bot.title}</span>
        {isMain ? (
          <MainBotBadge
            testId="bot-channel-row-main"
            tone={active ? "current" : "muted"}
          />
        ) : null}
        {muted ? (
          <BotMutedGlyph
            className={active ? "text-accent-foreground" : undefined}
            testId="bot-channel-row-muted"
          />
        ) : null}
      </span>
      {unreadCount === null ? null : (
        <UnreadCountBadge
          count={unreadCount}
          size="sm"
          testId="bot-channel-row-unread-count"
        />
      )}
    </button>
  );
}

/**
 * A bot's row with the menu that makes it its environment's main bot, from
 * the row's ⋮ (drawn on hover and keyboard focus, always on a touch screen)
 * or its context menu. The refusal of the write is stated under the row.
 */
function MakeMainChannelRow(props: {
  readonly bot: BotRecord;
  readonly children: ReactNode;
}): ReactNode {
  const { bot } = props;
  const client = useTabHostClient();
  const setMain = useEnvironmentSetMainBotMutation(client);
  const makeMain = (): void =>
    setMain.mutate({ environmentId: bot.environmentId, botId: bot.botId });
  return (
    <div className="flex flex-col gap-0.5">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group/row flex min-w-0 items-center gap-0.5">
            <div className="min-w-0 flex-1">{props.children}</div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Actions for ${bot.title}`}
                  data-testid="bot-channel-row-menu"
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/6 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 group-hover/row:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
                >
                  <EllipsisVertical className="size-3.5" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={setMain.isPending}
                  onSelect={makeMain}
                >
                  Make main
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={setMain.isPending} onSelect={makeMain}>
            Make main
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <BotSettingsRefusal
        message={setMain.error === null ? null : setMain.error.message}
      />
    </div>
  );
}

/**
 * Where a team's section would be, for a person in no team: the dashboard
 * page that makes one, outside the app. Nothing with no shell to open it.
 */
function CreateTeamRow(): ReactNode {
  const open = useDashboardPageOpener(createTeamDashboardUrl);
  if (open === null) return null;
  return (
    <button
      type="button"
      data-testid="bot-channel-create-team"
      onClick={open}
      className={SIDEBAR_ACTION_ROW_CLASS}
    >
      <Plus className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">Create a team</span>
      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
    </button>
  );
}
