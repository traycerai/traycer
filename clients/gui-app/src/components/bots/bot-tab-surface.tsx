import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import type { UseQueryResult } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { EllipsisVertical, Search } from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type {
  BotListResponse,
  BotOpenResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useInstalledAppTileForm } from "@/hooks/ui/use-installed-app-level2-form";
import { useKeyboardFocusOwnerWithin } from "@/hooks/ui/use-keyboard-focus-layout";
import type {
  MobileLevel2Form,
  MobileTileCount,
} from "@/lib/layout/mobile-layout-form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useClaimBotSurfaceFocus } from "@/hooks/notifications/use-publish-presented-bot-conversation";
import { BotsUnavailableNotice } from "@/components/bots/bots-unavailable-notice";
import {
  useBotSubscriptionForHost,
  type BotSubscriptionSnapshot,
} from "@/hooks/bots/use-bot-subscription";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import {
  BotLooksContext,
  botLooksOf,
  useChannelBackground,
} from "@/hooks/bots/use-bot-appearance";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { useBotListChangedSubscriptionForHost } from "@/hooks/bots/use-bot-list-changed-subscription";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentMemberDirectory } from "@/hooks/bots/use-environment-members-query";
import { useBotOpenMutation } from "@/hooks/bots/use-bot-mutations";
import { useTeamSetups } from "@/hooks/bots/use-team-setups";
import { botTabRouteOf, type BotTabRouteView } from "@/lib/bots/bot-tab-route";
import {
  TeamSetupChannel,
  TeamSetupHistoryRows,
} from "@/components/bots/team-setup-channel";
import { useTeamSetupHistory } from "@/hooks/bots/use-team-setup-history";
import { useArrangedBotsModel } from "@/hooks/bots/use-arranged-bots-model";
import {
  buildHomeBotsModel,
  type HomeBotsGroup,
} from "@/lib/home-bots/bots-model";
import { selectTracyChannel } from "@/lib/bots/open-bot-channel";
import {
  subscribeTabNavigationPending,
  tracyNavigationPending,
} from "@/lib/tab-navigation";
import { defaultTracyChannelOf } from "@/lib/bots/tracy-channel";
import {
  goneReportStands,
  handTracyLandingToChannel,
  useTracySurfaceStore,
} from "@/stores/bots/tracy-surface-store";
import {
  tracySessionOf,
  tracyViewOf,
  useTracyPlaceStore,
} from "@/stores/bots/tracy-place-store";
import { useTracyPlaceKey } from "@/hooks/bots/use-tracy-place-route";
import {
  isTracyChannelView,
  type TracyChannelView,
} from "@/lib/bots/tracy-place";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { TRACY_TAB_LABEL } from "@/stores/tabs/kinds/tracy";
import {
  useBotTabLandingStore,
  type BotTabLanding,
} from "@/stores/bots/bot-tab-landing-store";
import {
  BotChannelView,
  type BotChannelLanding,
} from "@/components/bots/bot-channel-view";
import {
  exchangeRailOver,
  memoryRailOver,
  sessionTargetOfTurn,
  useBotOpenThreadStore,
  useBotRail,
  type BotExchangeRail,
  type BotOpenExchange,
  type BotOpenMemory,
  type BotOpenThread,
  type BotSessionOpen,
  type BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";
import {
  openBotSearch,
  useBotSearchStore,
} from "@/stores/bots/bot-search-store";
import { registerBotChannelFind } from "@/lib/bots/bot-channel-find";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import {
  BotSessionView,
  type BotOpenSession,
} from "@/components/bots/bot-session-view";
import type { BotTranscriptLanding } from "@/components/bots/bot-chat-transcript";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotThreadsViewState } from "@/components/bots/bot-channel-sidebar";
import {
  BotChannelColumn,
  BotChannelTitle,
  BotUnselectedLevel2Pane,
} from "@/components/bots/bot-channel-level2";
import { BotActivityPage } from "@/components/bots/bot-activity-page";
import { BotSessionStatusDataContext } from "@/components/bots/bot-session-status-context";
import { BotThreadsView } from "@/components/bots/bot-threads-view";
import { useBotThreadListQuery } from "@/hooks/bots/use-bot-thread-list-query";
import { useBotActiveTasks } from "@/hooks/bots/use-bot-active-tasks";
import { UnreadCountBadge } from "@/components/notifications/unread-count-badge";
import { BotChannelSettingsPanel } from "@/components/bots/bot-settings-panel";
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  BotMemoryContext,
  type BotMemoryAccess,
} from "@/components/bots/bot-memory-context";
import { BotSettingsOpenerContext } from "@/components/bots/bot-settings-opener-context";
import { ExpressiveBotAvatar } from "@/components/bots/bot-avatars";
import { botExpressionOf, useBotActivity } from "@/hooks/bots/use-bot-activity";
import { BotIdentityTrigger } from "@/components/bots/bot-identity-popover";
import { MainBotBadge } from "@/components/bots/main-bot-badge";
import { BotMentionsContext } from "@/components/bots/bot-mentions-context";
import {
  useBotMentionDirectory,
  useBotOwner,
} from "@/components/bots/use-bot-surface-scope";
import { isMainBot, type MainBotIds } from "@/lib/bots/bot-main";
import {
  botPausedCopy,
  botTabOpenState,
  type BotTabPausedReason,
} from "@/components/bots/bot-tab-open-state";
import { cn } from "@/lib/utils";

type BotTabView = TracyChannelView;

/**
 * The Tracy surface (decision 150): one per window, Slack's layout (decision
 * 41) - the person's environments and their bots as channels down the side,
 * and the selected channel beside them. Picking a channel swaps the pane in
 * place; the surface never becomes another tab.
 *
 * The person never picks the machine a bot runs on: the surface is bound to
 * ONE host through `TabHostProvider` (the window's, when it first opened) and
 * stays there whatever channel shows - that host serves every bot's
 * channel, its threads and what the bot is doing, whether it runs the bot or
 * another host does; the bot's host only runs its turns. A surface left on a
 * host this client can no longer dial is moved to the window's host by the
 * next opener (`openBotChannel`); the surface itself never reads the
 * app-wide host. While anything about its host is unknown it shows its
 * connecting state, never nothing.
 */
export function BotTabSurface(props: {
  readonly botId: string | null;
  readonly hostId: string;
}): ReactNode {
  const { botId, hostId } = props;
  useClaimBotSurfaceFocus();
  // A RESTORED surface (the store persists) meets whatever its host
  // advertises now. `bot.open` is the newest method of the `bot.*` block, so
  // its presence stands for every write the surface offers; without it the
  // surface shows the update notice and no control that would call a method
  // the host lacks.
  const support = useHostMethodSupport(hostId, "bot.open");
  if (support === null) return <BotTabConnecting />;
  if (!support) {
    return (
      <div
        className="flex h-full flex-col justify-center"
        data-testid="bot-tab"
      >
        <BotsUnavailableNotice testId="bot-tab-unavailable" />
      </div>
    );
  }
  return (
    <TabHostProvider key={hostId} hostId={hostId}>
      <TracySurfaceShell botId={botId} hostId={hostId} />
    </TabHostProvider>
  );
}

/**
 * The surface's stable shell: the host, the channel column, the Threads row
 * and view, and only the selected channel's pane keyed by its bot - so a
 * switch, a channel still connecting, a team's setup, or a channel that
 * failed to open never blanks the column, and another channel can always be
 * picked. Threads, from the column, shows in place of the channel until a
 * channel is chosen; selecting one leaves it.
 *
 * The shell keeps the per-channel state of every channel shown since the
 * surface opened (its rail, drafts, surface actions, landing) and forgets a
 * bot's once it is gone: deleted, or missing from a list that answered after
 * carrying it. A list that has not answered, or whose read failed, removes
 * nothing, and a team's main bot still to be set up is never taken for a
 * deleted one. With no channel selected, or the selected bot gone, the
 * default channel is selected (`defaultTracyChannelOf`).
 */
function TracySurfaceShell(props: {
  readonly botId: string | null;
  readonly hostId: string;
}): ReactNode {
  const { botId, hostId } = props;
  const navigate = useNavigate();
  const client = useTabHostClient();
  const botList = useBotListQuery(client, true);
  const environments = useEnvironmentListQuery(true);
  // A teammate's rename, claim or delete reaches the list (and so the
  // surface) without waiting for focus, through the surface's own host.
  useBotListChangedSubscriptionForHost(hostId, true);
  const groups = useBotsGroups(botList.data, environments.data);
  // Every picture on the surface draws what its own host's list chose.
  const looks = useMemo(
    () => (botList.data === undefined ? null : botLooksOf(botList.data)),
    [botList.data],
  );

  // Threads, from the column, in place of the channel; any move to one of
  // the channel's views ends it, and so does selecting a channel.
  // Threads also takes the place of a session: leaving it shows the channel.
  const threadsShown = useTracyPlaceStore((state) => state.threadsShown);
  const leaveThreads = useCallback(
    () => useTracyPlaceStore.getState().setThreadsShown(false),
    [],
  );
  const threadsView = useMemo(
    (): BotThreadsViewState => ({
      shown: threadsShown,
      onShow: () => {
        const place = useTracyPlaceStore.getState();
        if (botId !== null) place.setSession(botId, null);
        place.setThreadsShown(true);
      },
      onLeave: leaveThreads,
    }),
    [botId, leaveThreads, threadsShown],
  );

  const { level2, tiles, onRailDrawn } = useSurfaceTileForm();
  const shown = usePaneVisible();
  const select = useCallback(
    (next: string | null) => selectTracyChannel(navigate, next, shown),
    [navigate, shown],
  );
  const { forget: forgetChannel, unavailable } = useTracyChannelUpkeep({
    botId,
    groups,
    listed: botList.status === "success" ? botList.data.bots : null,
    listedAt: botList.dataUpdatedAt,
    select,
  });
  useSenderLandingSpentOnDeparture(botId);
  const channelTitle =
    botList.data?.bots.find((bot) => bot.botId === botId)?.title ??
    TRACY_TAB_LABEL;
  const { refetch: refetchBots } = botList;
  const { refetch: refetchEnvironments } = environments;
  const retryLists = useCallback(() => {
    void refetchBots();
    void refetchEnvironments();
  }, [refetchBots, refetchEnvironments]);

  return (
    <BotLooksContext value={looks}>
      <div
        className="@container flex h-full min-h-0"
        data-testid="bot-tab"
        data-bot-surface=""
      >
        <BotChannelColumn
          level2={level2}
          activeBotId={botId}
          hostId={hostId}
          threadsView={threadsView}
        />
        <div
          className="relative flex min-h-0 min-w-0 flex-1 md:bg-canvas"
          data-testid="bot-tab-content-pane"
        >
          {/* Threads, from the column, takes the place of the channel's
            views and of a session. */}
          {threadsShown ? (
            <BotThreadsView
              hostId={hostId}
              channelTitle={channelTitle}
              onBack={leaveThreads}
              level2={level2}
            />
          ) : null}
          {botId === null && !threadsShown ? (
            <BotUnselectedLevel2Pane
              level2={level2}
              title={TRACY_TAB_LABEL}
              hostId={hostId}
              threadsView={threadsView}
            >
              <TracyUnselected
                groups={groups}
                unavailable={unavailable}
                listsFailed={
                  botList.status === "error" || environments.status === "error"
                }
                onRetry={retryLists}
              />
            </BotUnselectedLevel2Pane>
          ) : null}
          {botId === null ? null : (
            <TracyChannelPane
              key={botId}
              botId={botId}
              hostId={hostId}
              level2={level2}
              tiles={tiles}
              onRailDrawn={onRailDrawn}
              threadsView={threadsView}
              onGone={forgetChannel}
            />
          )}
        </div>
      </div>
    </BotLooksContext>
  );
}

/**
 * The installed app's form for the surface, both halves `null` everywhere else.
 * The second tile is the rail the channel draws beside itself, and only the
 * channel's pane knows it is drawn, so the pane says.
 */
function useSurfaceTileForm(): {
  readonly level2: MobileLevel2Form | null;
  readonly tiles: MobileTileCount | null;
  readonly onRailDrawn: (drawn: boolean) => void;
} {
  const [railDrawn, setRailDrawn] = useState(false);
  const form = useInstalledAppTileForm(railDrawn ? 2 : 1);
  return {
    level2: form?.level2 ?? null,
    tiles: form?.tiles ?? null,
    onRailDrawn: setRailDrawn,
  };
}

/**
 * A `sender` landing waits in its channel's pane for the thread list, and a
 * move of the channel while it waits spends it unlanded
 * (`useSpendTabLanding`). Leaving the channel is such a move, but it unmounts
 * the pane and its wait with it, so the shell spends it here: the sender
 * landing the channel held while shown is withdrawn once another is selected.
 * Only that same request: one asked of the channel since (an opener staging
 * it before navigating back) is the channel's next landing.
 */
function useSenderLandingSpentOnDeparture(botId: string | null): void {
  const shownLanding = useBotTabLandingStore((state) =>
    botId !== null && Object.hasOwn(state.byBotId, botId)
      ? state.byBotId[botId]
      : null,
  );
  const held = useRef<{
    readonly botId: string;
    readonly landing: BotTabLanding;
  } | null>(null);
  useEffect(() => {
    // Compared with the channel last seen, not run on cleanup, so a remount
    // of the same channel is no departure.
    const previous = held.current;
    if (previous !== null && previous.botId !== botId) {
      const { byBotId, clear } = useBotTabLandingStore.getState();
      if (
        Object.hasOwn(byBotId, previous.botId) &&
        byBotId[previous.botId] === previous.landing
      ) {
        clear(previous.botId);
      }
    }
    held.current =
      botId !== null && shownLanding?.kind === "sender"
        ? { botId, landing: shownLanding }
        : null;
  }, [botId, shownLanding]);
}

/**
 * Keeps the visited channels' state in step with the bots that exist, and a
 * channel selected: forgets each visited bot, and each bot a box holds a
 * draft for, once a list that answered no longer carries it after carrying
 * it, and returns the way the selected
 * channel's own pane reports one gone. With no channel selected, or the
 * selected one gone, `select`s the default channel once the lists answered.
 *
 * The default is the surface's own choice, never an opener's: while a
 * navigation to the surface is in flight (a channel someone opened, not yet
 * acknowledged) it waits, so it never supersedes that navigation, and a
 * selected bot that goes away meanwhile is only deselected. A bot reported
 * gone is never the default (`unavailable`) while its report stands: the
 * list it was reported against still carries it, and so can a list another
 * host answered earlier. Only a list that answered after the report and
 * carries the bot takes the report away (`settleListedBots`).
 */
function useTracyChannelUpkeep(input: {
  readonly botId: string | null;
  readonly groups: ReadonlyArray<HomeBotsGroup> | null;
  /** The bots of the last list read that succeeded; `null` before one. */
  readonly listed: ReadonlyArray<BotRecord> | null;
  /** When the last list read that succeeded answered; `0` before one. */
  readonly listedAt: number;
  readonly select: (botId: string | null) => void;
}): {
  readonly forget: (botId: string) => void;
  readonly unavailable: ReadonlySet<string>;
} {
  const { botId, groups, listed, listedAt, select } = input;
  // Each bot reported gone, with the list read it was reported against: the
  // one record the default below and the history's prune and skip both read.
  const goneReports = useTracySurfaceStore((state) => state.goneReports);
  // Read against the list in hand, not only the reports as last settled: a
  // list that takes a report away is in this render before the effect below
  // has taken it out of the store, and the default must not pass the bot over
  // meanwhile.
  const unavailable = useMemo(() => {
    const listedIds = new Set(listed?.map((bot) => bot.botId));
    return new Set(
      Object.entries(goneReports)
        .filter(([goneBotId, reportedAt]) =>
          goneReportStands(reportedAt, listedIds.has(goneBotId), listedAt),
        )
        .map(([goneBotId]) => goneBotId),
    );
  }, [goneReports, listed, listedAt]);
  const forget = useCallback(
    (goneBotId: string): void => {
      const surface = useTracySurfaceStore.getState();
      surface.forgetBot(goneBotId, listedAt);
      if (goneBotId !== surface.botId) return;
      if (tracyNavigationPending()) {
        surface.selectChannel(null);
        return;
      }
      select(
        groups === null
          ? null
          : defaultTracyChannelOf(groups, new Set([...unavailable, goneBotId])),
      );
    },
    [groups, listedAt, select, unavailable],
  );
  const visitedBotIds = useTracySurfaceStore((state) => state.visitedBotIds);
  // A box's draft outlives the visit (Tracy Bots T158): its bot is kept in
  // step with the list too.
  const draftBotIds = useBotDraftsStore(
    useShallow((state) => Object.keys(state.threadBoxes)),
  );
  const seenListedRef = useRef(new Set<string>());
  useEffect(() => {
    if (listed === null) return;
    const listedIds = new Set(listed.map((bot) => bot.botId));
    useTracySurfaceStore.getState().settleListedBots(listedIds, listedAt);
    const seen = seenListedRef.current;
    for (const kept of new Set([...visitedBotIds, ...draftBotIds])) {
      if (listedIds.has(kept)) {
        seen.add(kept);
      } else if (seen.has(kept)) {
        seen.delete(kept);
        forget(kept);
      }
    }
  }, [draftBotIds, forget, listed, listedAt, visitedBotIds]);
  const defaultBotId =
    groups === null ? null : defaultTracyChannelOf(groups, unavailable);
  const navigationPending = useSyncExternalStore(
    subscribeTabNavigationPending,
    tracyNavigationPending,
  );
  useEffect(() => {
    if (botId !== null || defaultBotId === null || navigationPending) return;
    select(defaultBotId);
  }, [botId, defaultBotId, navigationPending, select]);
  return { forget, unavailable };
}

/** The channel column's groups; `null` until both lists answer. */
function useBotsGroups(
  bots: BotListResponse | undefined,
  environments: EnvironmentListResponseV11 | undefined,
): ReadonlyArray<HomeBotsGroup> | null {
  // In the order the person gave the column (decision 151), so the default's
  // "first channel" is the first one drawn.
  const model = useArrangedBotsModel(
    useMemo(
      () =>
        buildHomeBotsModel({
          environments: environments?.environments ?? [],
          bots: bots?.bots ?? [],
          mainBotIds: bots?.mainBotIds ?? null,
        }),
      [bots, environments],
    ),
  );
  return bots === undefined || environments === undefined ? null : model.groups;
}

/**
 * The pane with no channel selected. Until both lists have answered: the
 * connecting state, or, when a read failed, the failure and a Retry of both
 * (the default channel is chosen from them, so nothing else would recover).
 * Then: that there are no bots, when there are none but the `unavailable`
 * ones; otherwise nothing, as the default channel (or a navigation in
 * flight) is on its way.
 */
function TracyUnselected(props: {
  readonly groups: ReadonlyArray<HomeBotsGroup> | null;
  readonly unavailable: ReadonlySet<string>;
  readonly listsFailed: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  const { groups } = props;
  if (groups === null) {
    return props.listsFailed ? (
      <ErrorNotice
        text="Couldn't load this channel."
        onRetry={props.onRetry}
        className="m-4"
      />
    ) : (
      <BotTabConnecting />
    );
  }
  return defaultTracyChannelOf(groups, props.unavailable) === null ? (
    <TracyNoChannel />
  ) : null;
}

/** The surface with no channel: there is no bot to show yet. */
function TracyNoChannel(): ReactNode {
  return (
    <div
      className="flex flex-1 items-center justify-center p-6 text-center text-ui-sm text-muted-foreground"
      data-testid="bot-tab-no-channel"
    >
      No bots yet. Create one from Home.
    </div>
  );
}

/**
 * What a channel shows (`botTabRouteOf`), read through the surface's lists,
 * and the Retry for the reads that failed (`null` when none did). A bot not
 * yet seen listed is read again while the list is older than the pane or
 * than the newest setup read.
 */
function useChannelRoute(
  botId: string,
  hostId: string,
): {
  readonly route: BotTabRouteView;
  readonly botList: UseQueryResult<BotListResponse, HostRpcError>;
  readonly retry: (() => void) | null;
} {
  const client = useTabHostClient();
  const botList = useBotListQuery(client, true);
  const environments = useEnvironmentListQuery(true);
  const groups = useBotsGroups(botList.data, environments.data);
  const teamSetups = useTeamSetups({ client, hostId, groups });
  const listed = botList.data?.bots.some((bot) => bot.botId === botId) ?? false;
  const [shownListed, setShownListed] = useState(false);
  if (listed && !shownListed) setShownListed(true);
  const unlisted = !listed && !shownListed;
  const setup = unlisted
    ? teamSetups.setups.find((entry) => entry.botId === botId)
    : undefined;
  // A refresh that failed keeps the list it had: it is asked again only on
  // Retry, never in a loop. A kept environment list may predate a team, whose
  // setup would then go unread, so its failure is the bot list's too.
  const botListFailed = botList.status === "error";
  const environmentsFailed = environments.status === "error";
  const listsFailed = botListFailed || environmentsFailed;
  const listStale =
    unlisted &&
    setup === undefined &&
    (!botList.isFetchedAfterMount || botList.dataUpdatedAt < teamSetups.readAt);
  const { isFetching: listFetching, refetch: refetchList } = botList;
  useEffect(() => {
    if (listStale && !listsFailed && !listFetching) void refetchList();
  }, [listsFailed, listFetching, listStale, refetchList]);
  const route = botTabRouteOf({
    listsPending:
      botList.status === "pending" || environments.status === "pending",
    seenListed: !unlisted,
    listsAnswered: groups !== null,
    listsFailed,
    setup: setup ?? null,
    listStale,
    setupsSettled: teamSetups.settled,
    setupsUnresolved: teamSetups.unresolved,
  });
  const retry = retryFailedReads([
    { failed: botListFailed, retry: () => void refetchList() },
    {
      failed: environmentsFailed,
      retry: () => void environments.refetch(),
    },
    { failed: teamSetups.retryable, retry: teamSetups.retry },
  ]);
  return { route, botList, retry };
}

/**
 * One channel of the surface, keyed by its bot: whether it is a listed bot,
 * whose channel opens, or a team's main bot still to be set up, whose setup
 * it shows. A bot that is neither is a listed bot's channel all the same,
 * reported gone once the list does not carry it.
 *
 * A bot this pane has shown listed is that bot until a list without it
 * reports it gone. Any other bot may be a team's main bot still to be set
 * up, so it is never taken for a deleted one on a list older than the pane
 * or than the newest setup read: the list is read again first, so a main bot
 * created since is found rather than reported gone. Only lists that were
 * read say what is absent: while either list has not answered or its last
 * read failed, or a team with no bot cannot be told apart (`unresolved`: its
 * setup read failed, or the host does not answer it), the pane says the
 * channel could not be loaded and, when a read failed, offers to read it
 * again (`botTabRouteOf`).
 */
function TracyChannelPane(props: {
  readonly botId: string;
  readonly hostId: string;
  /** The shell's level-2 form, which the channel's title follows. */
  readonly level2: MobileLevel2Form | null;
  /** The shell's tile count, which places the rail beside the channel. */
  readonly tiles: MobileTileCount | null;
  readonly onRailDrawn: (drawn: boolean) => void;
  /** The shell's Threads, shown in place of the channel's views. */
  readonly threadsView: BotThreadsViewState;
  readonly onGone: (botId: string) => void;
}): ReactNode {
  const { botId, hostId, level2, threadsView } = props;
  const threadsShown = threadsView.shown;
  const client = useTabHostClient();
  // The channel shows: it is visited. Before any passive effect of the
  // pane's, so a channel reported gone on its first commit is forgotten after
  // it was marked visited, not before.
  useLayoutEffect(() => {
    useTracySurfaceStore.getState().markVisited(botId);
  }, [botId]);
  // Each landing the shown channel observes is its own from that commit on,
  // including one asked of it while it was already showing, so a later
  // navigation elsewhere does not withdraw it as never landed.
  const landing = useBotTabLandingStore((state) =>
    Object.hasOwn(state.byBotId, botId) ? state.byBotId[botId] : null,
  );
  useLayoutEffect(() => {
    if (landing !== null) handTracyLandingToChannel(botId, landing);
  }, [botId, landing]);
  const { route, botList, retry } = useChannelRoute(botId, hostId);
  if (threadsShown && route.kind !== "bot") return null;
  if (route.kind === "connecting") return <BotTabConnecting />;
  if (route.kind === "setup") {
    return (
      <TeamSetupChannel
        setup={route.setup}
        client={client}
        hostId={hostId}
        level2={level2}
        threadsView={threadsView}
      />
    );
  }
  if (route.kind === "unresolved") {
    return (
      <ErrorNotice
        text="Couldn't load this channel."
        onRetry={retry}
        className="m-4"
      />
    );
  }
  return (
    <BotTabBody
      botId={botId}
      hostId={hostId}
      listedBots={botList.data?.bots}
      mainBotIds={botList.data?.mainBotIds}
      level2={level2}
      tiles={props.tiles}
      onRailDrawn={props.onRailDrawn}
      threadsView={threadsView}
      onGone={props.onGone}
    />
  );
}

function BotTabBody(props: {
  readonly botId: string;
  readonly hostId: string;
  /** `bot.list`'s bots; `undefined` until the list answers. */
  readonly listedBots: ReadonlyArray<BotRecord> | undefined;
  readonly mainBotIds: MainBotIds | undefined;
  readonly level2: MobileLevel2Form | null;
  readonly tiles: MobileTileCount | null;
  readonly onRailDrawn: (drawn: boolean) => void;
  readonly threadsView: BotThreadsViewState;
  readonly onGone: (botId: string) => void;
}): ReactNode {
  const { botId, hostId, listedBots, threadsView, onGone } = props;
  const { shown: threadsShown, onLeave: onLeaveThreads } = threadsView;
  const subscription = useBotSubscriptionForHost({
    botId,
    hostId,
    enabled: true,
  });
  const client = useTabHostClient();
  const view = useTracyPlaceStore((state) =>
    tracyViewOf(state.viewByBotId, botId),
  );
  const changeView = useCallback(
    (next: BotTabView) => {
      useTracyPlaceStore.getState().setView(botId, next);
      onLeaveThreads();
    },
    [botId, onLeaveThreads],
  );

  // Open once per channel - this body is keyed by its bot - and again on
  // Retry or when the surface comes back into view. A mutation, not a query:
  // an open may claim the bot onto this host, which a background refetch
  // must never do on its own. The last answer is HELD across a re-open, so
  // asking again never blanks a channel that is serving; a failed re-open is
  // shown above it instead. The answer feeds only the channel's paused,
  // failed and opening states: whatever it says, the surface stays on its
  // host.
  const { mutate: openBot } = useBotOpenMutation(client);
  const [answer, setAnswer] = useState<BotOpenResponse | undefined>(undefined);
  const [openError, setOpenError] = useState<string | null>(null);
  const reopen = useCallback(
    () =>
      openBot(
        { botId },
        {
          onSuccess: (response) => {
            setAnswer(response);
            setOpenError(null);
          },
          onError: (error) => setOpenError(error.message),
        },
      ),
    [botId, openBot],
  );
  useEffect(() => {
    reopen();
  }, [reopen]);
  // An open made while the connection comes back fails with nothing else to
  // ask again, most often the one a phone sends as it returns to the app.
  const reopenFailedOpen = useEffectEvent(() => {
    if (openError !== null) reopen();
  });
  useEffect(() => {
    if (client === null) return undefined;
    return client.onChange((event) => {
      if (event.reason !== "availability-recovered") return;
      if (event.currentHostId === hostId) reopenFailedOpen();
    });
  }, [client, hostId]);

  const openState = botTabOpenState({
    response: answer,
    error: answer === undefined ? openError : null,
  });

  // A deleted bot's channel is gone from the surface. Two signals say so -
  // the stream's `deleted` frame, and a `bot.list` answer that no longer
  // carries the bot, which is how a delete made while this stream was down
  // reaches the channel, and how a `bot.open` that found no bot does (every
  // open invalidates the list).
  const goneFromList =
    listedBots !== undefined && !listedBots.some((bot) => bot.botId === botId);
  const reportGone = useEffectEvent(() => onGone(botId));
  const deleted = useCallback(() => onGone(botId), [botId, onGone]);
  useEffect(() => {
    if (subscription.deleted || goneFromList) reportGone();
  }, [goneFromList, subscription.deleted]);

  // The host re-sends a snapshot only for changes IT made; a bot rebound or
  // edited from another host reaches this client on the next subscribe, so
  // the channel asks again - and opens again, since the bot's host may have
  // come back or gone away - when it comes back into view: the window
  // becoming visible, and the surface becoming the active tab (inactive tabs
  // stay mounted, hidden).
  const { resubscribe } = subscription;
  const refresh = useCallback(() => {
    reopen();
    resubscribe();
  }, [reopen, resubscribe]);
  const paneVisible = usePaneVisible();
  const wasVisibleRef = useRef(paneVisible);
  useEffect(() => {
    const becameVisible = paneVisible && !wasVisibleRef.current;
    wasVisibleRef.current = paneVisible;
    if (becameVisible) refresh();
  }, [paneVisible, refresh]);
  // Only the surface in view re-opens when the window returns: an open can
  // claim the bot onto this host, and a hidden tab is not a person asking
  // for it.
  const onWindowVisible = useEffectEvent(() => {
    if (document.visibilityState === "visible") refresh();
  });
  useEffect(() => {
    if (!paneVisible) return undefined;
    const onVisibilityChange = (): void => onWindowVisible();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [paneVisible]);

  if (openState.kind === "failed") {
    return threadsShown ? null : (
      <ErrorNotice
        text={`Couldn't open this bot: ${openState.message}`}
        onRetry={reopen}
        className="m-4"
      />
    );
  }
  const snapshot = subscription.snapshot;
  if (snapshot === null && subscription.error !== null) {
    return threadsShown ? null : (
      <ErrorNotice
        text={`Couldn't reach this bot: ${subscription.error}`}
        onRetry={resubscribe}
        className="m-4"
      />
    );
  }
  if (snapshot === null || openState.kind === "opening") {
    return threadsShown ? null : <BotTabConnecting />;
  }

  return (
    <BotTabContent
      botId={botId}
      hostId={hostId}
      snapshot={snapshot}
      pausedReason={openState.kind === "paused" ? openState.reason : null}
      reopenError={openError}
      onReopen={reopen}
      streamError={subscription.error}
      snapshotFresh={subscription.snapshotFresh}
      onRetry={resubscribe}
      view={view}
      onViewChange={changeView}
      level2={props.level2}
      tiles={props.tiles}
      onRailDrawn={props.onRailDrawn}
      threadsView={threadsView}
      onDeleted={deleted}
      mainBotIds={props.mainBotIds}
    />
  );
}

/**
 * The rail's one slot - a thread, the bot's memory or a search - held in its
 * store, above the views, so it survives a switch between the channel's tabs;
 * and the ways Activity and the bot's profile card open it beside the
 * channel, switching to Messages. A thread a search result opened is the open
 * thread like any other, with the search still behind it.
 */
function useBotTabRail(
  botId: string,
  onViewChange: (view: BotTabView) => void,
): {
  readonly openThread: BotOpenThread | null;
  readonly openMemory: BotOpenMemory | null;
  readonly searchResultsOpen: boolean;
  readonly setOpenThread: (open: BotOpenThread | null) => void;
  readonly setOpenMemory: (open: BotOpenMemory | null) => void;
  readonly openMemoryInChannel: () => void;
  readonly openExchange: BotOpenExchange | null;
  readonly exchanges: BotExchangeRail;
} {
  const rail = useBotRail(botId);
  const setRail = useBotOpenThreadStore((s) => s.setRail);
  const searchShowing = rail?.kind === "search" ? rail.showing : null;
  const searchThread =
    searchShowing?.kind === "thread" ? searchShowing.thread : null;
  const openThread = rail?.kind === "thread" ? rail : searchThread;
  const openMemory = rail?.kind === "memory" ? rail : null;
  const openExchange = rail?.kind === "exchange" ? rail : null;
  // A pair's log takes the slot over whatever it holds; closing it brings
  // that back.
  const exchanges = useMemo(
    (): BotExchangeRail => ({
      open: (peerBotId) => setRail(botId, exchangeRailOver(rail, peerBotId)),
      close: () => setRail(botId, rail?.kind === "exchange" ? rail.back : rail),
    }),
    [botId, rail, setRail],
  );
  const setOpenMemory = useCallback(
    (open: BotOpenMemory | null) =>
      setRail(botId, open === null ? null : { kind: "memory", ...open }),
    [botId, setRail],
  );
  // From the profile card: the memory takes the slot beside the channel.
  const openMemoryInChannel = useCallback(() => {
    setRail(botId, memoryRailOver(rail));
    onViewChange("messages");
  }, [botId, onViewChange, rail, setRail]);
  const setOpenThread = useCallback(
    (open: BotOpenThread | null) =>
      setRail(botId, open === null ? null : { kind: "thread", ...open }),
    [botId, setRail],
  );
  return {
    openThread,
    openMemory,
    searchResultsOpen: searchShowing?.kind === "results",
    setOpenThread,
    setOpenMemory,
    openMemoryInChannel,
    openExchange,
    exchanges,
  };
}

/**
 * How the channel's search opens: the header's button and ⌘F, on this bot,
 * while a host that takes it serves the tab (`null` otherwise). Each opening,
 * the column's box included, shows the channel it opened beside: Messages,
 * in place of a session or Threads. A session has its own find, and Threads
 * no channel, so ⌘F is theirs while they show.
 */
function useChannelSearchEntry(args: {
  readonly botId: string;
  readonly hostId: string;
  readonly channelShown: boolean;
  readonly onShow: () => void;
}): (() => void) | null {
  const { botId, channelShown, onShow } = args;
  const supported =
    useHostMethodSupport(args.hostId, "bot.conversation.search") === true;
  const opens = useBotSearchStore((state) => state.opens);
  const seenOpens = useRef(opens);
  const showChannel = useEffectEvent(onShow);
  useEffect(() => {
    if (seenOpens.current === opens) return;
    seenOpens.current = opens;
    showChannel();
  }, [opens]);
  const open = useCallback(
    () => openBotSearch(botId, { kind: "bot", botId }, null),
    [botId],
  );
  const paneVisible = usePaneVisible();
  useEffect(() => {
    if (!supported || !paneVisible || !channelShown) return undefined;
    return registerBotChannelFind(open);
  }, [channelShown, open, paneVisible, supported]);
  return supported ? open : null;
}

/**
 * The bot's session shown in place of the channel's views,
 * and where the channel lands once it is back. A receipt, a check-in's link
 * or a thread's "Thread session" opens a session; each open is a new visit,
 * so the same turn opened again lands again. The session's links show the
 * channel - on a post, or with a thread beside it - in Messages; its back
 * button returns to the view it was opened from, the channel where it was.
 * Either lands on its message once: leaving the place it was asked on, by
 * a button or a step back or forward, drops the landing.
 * Threads takes the place of a session as well: leaving it shows the
 * channel, since a session open when Threads was chosen is not where either
 * way back says it goes.
 */
function useBotTabSession(args: {
  readonly botId: string;
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly onViewChange: (view: BotTabView) => void;
  readonly setOpenThread: (open: BotOpenThread | null) => void;
}): {
  readonly session: BotOpenSession | null;
  readonly channelLanding: BotChannelLanding | null;
  readonly openSession: BotSessionOpen;
  readonly openTurn: BotTurnOpen;
  readonly closeSession: () => void;
  readonly showChannel: (messageId: string | null) => void;
  readonly landChannel: (messageId: string | null) => void;
  readonly showThread: (threadId: string, messageId: string | null) => void;
} {
  const { botId, threads, onViewChange, setOpenThread } = args;
  // Which session shows is the surface's place, kept in its store; where it
  // lands is this visit's alone, and holds only for the session it was
  // opened on: a session a step back or forward shows opens where it opens.
  const shownSession = useTracyPlaceStore((state) =>
    tracySessionOf(state.sessionByBotId, botId),
  );
  const [shown, setShown] = useState<{
    readonly sessionLanding: {
      readonly chatId: string;
      readonly landOn: BotTranscriptLanding;
    } | null;
    readonly channelLanding: BotChannelLanding | null;
    readonly visits: number;
  }>({ sessionLanding: null, channelLanding: null, visits: 0 });
  // A landing belongs to the visit that asked for it. The view it landed in
  // is gone once the surface is anywhere else, and the place shown again
  // mounts a new one, which must not jump to that message a second time.
  const placeKey = useTracyPlaceKey(botId);
  const [landedAt, setLandedAt] = useState<{
    readonly visit: number;
    readonly placeKey: string;
  } | null>(null);
  const landing = shown.sessionLanding?.landOn ?? shown.channelLanding;
  if (landing === null) {
    if (landedAt !== null) setLandedAt(null);
  } else if (landedAt?.visit !== landing.visit) {
    setLandedAt({ visit: landing.visit, placeKey });
  } else if (landedAt.placeKey !== placeKey) {
    setShown({ ...shown, sessionLanding: null, channelLanding: null });
  }
  const session = useMemo(
    (): BotOpenSession | null =>
      shownSession === null
        ? null
        : {
            chatId: shownSession.chatId,
            threadId: shownSession.threadId,
            landOn:
              shown.sessionLanding?.chatId === shownSession.chatId
                ? shown.sessionLanding.landOn
                : null,
          },
    [shown.sessionLanding, shownSession],
  );
  const openSession = useCallback<BotSessionOpen>(
    (target) => {
      const { chatId, messageId } = target;
      setShown((previous) => {
        const visit = previous.visits + 1;
        return {
          sessionLanding:
            messageId === null
              ? null
              : {
                  chatId,
                  landOn: { messageId, sendPostId: target.sendPostId, visit },
                },
          channelLanding: null,
          visits: visit,
        };
      });
      useTracyPlaceStore
        .getState()
        .setSession(botId, { chatId, threadId: target.threadId });
    },
    [botId],
  );
  const openTurn = useCallback<BotTurnOpen>(
    (ref, sendPostId) => openSession(sessionTargetOfTurn(ref, sendPostId)),
    [openSession],
  );
  const closeSession = useCallback(
    () => useTracyPlaceStore.getState().setSession(botId, null),
    [botId],
  );
  // The channel shows, landed on a message of it or of the thread beside it.
  const showLanded = useCallback(
    (landOn: Omit<BotChannelLanding, "visit"> | null) => {
      setShown((previous) => {
        const visit = previous.visits + 1;
        return {
          sessionLanding: null,
          channelLanding: landOn === null ? null : { ...landOn, visit },
          visits: visit,
        };
      });
      useTracyPlaceStore.getState().setSession(botId, null);
      onViewChange("messages");
    },
    [botId, onViewChange],
  );
  // A row of the channel shows with nothing beside it: a thread left open
  // there is not what was asked for. Back to the channel (`null`) keeps it.
  const showChannel = useCallback(
    (messageId: string | null) => {
      if (messageId === null) {
        showLanded(null);
        return;
      }
      setOpenThread(null);
      showLanded({ messageId, sendPostId: null, threadId: null });
    },
    [setOpenThread, showLanded],
  );
  // A landing asked of the tab from outside it (a tapped push) shows the
  // channel with nothing beside it, on its row where one is named. Unlike
  // Back to the channel, it is never a return to a thread left open.
  const landChannel = useCallback(
    (messageId: string | null) => {
      setOpenThread(null);
      showLanded(
        messageId === null
          ? null
          : { messageId, sendPostId: null, threadId: null },
      );
    },
    [setOpenThread, showLanded],
  );
  // A thread the list does not name has no post to open it by: the channel
  // shows instead, with no other thread beside it. One it names opens on
  // `messageId` where one is named.
  const showThread = useCallback(
    (threadId: string, messageId: string | null) => {
      const anchor =
        threads?.find((thread) => thread.threadId === threadId)?.anchor ?? null;
      showLanded(
        anchor === null || messageId === null
          ? null
          : { messageId, sendPostId: null, threadId },
      );
      setOpenThread(
        anchor === null
          ? null
          : {
              anchorMessageId: anchor.messageId,
              announcement: false,
              anchorKind: null,
              sent: null,
            },
      );
    },
    [setOpenThread, showLanded, threads],
  );
  return {
    session,
    channelLanding: shown.channelLanding,
    openSession,
    openTurn,
    closeSession,
    showChannel,
    landChannel,
    showThread,
  };
}

/**
 * Where the tab is: its view, Threads in its place, the session shown, what
 * the rail beside the channel holds, and the channel's landing.
 */
type BotTabPlace = {
  readonly view: BotTabView;
  readonly threadsShown: boolean;
  readonly session: BotOpenSession | null;
  readonly openThread: BotOpenThread | null;
  readonly openMemory: BotOpenMemory | null;
  readonly searchResultsOpen: boolean;
  readonly channelLanding: BotChannelLanding | null;
};

/** A landing kept for a read of the thread list, and where the tab was then. */
type WaitingLanding = {
  readonly landing: BotTabLanding;
  readonly place: BotTabPlace;
};

/**
 * A `sender` landing: the thread whose session sent beside the channel, or
 * the channel, once no read of the list is in flight that may bring the
 * thread; a failed first read brings none, so the channel shows. A move of
 * the tab while it waits spends it unlanded.
 */
function spendSenderLanding(input: {
  readonly botId: string;
  readonly landing: Extract<BotTabLanding, { kind: "sender" }>;
  /** `null` while the list is first read, or when that read failed. */
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly threadsFetching: boolean;
  /** The last read of the list failed: no answer is coming without a new one. */
  readonly threadsFailed: boolean;
  readonly place: BotTabPlace;
  readonly waiting: { current: WaitingLanding | null };
  readonly landChannel: (messageId: string | null) => void;
  readonly showThread: (threadId: string, messageId: string | null) => void;
}): void {
  const { landing, threads, place, waiting } = input;
  const held = waiting.current?.landing === landing ? waiting.current : null;
  const thread = threads?.find((t) => t.sessionChatId === landing.chatId);
  const moved = held !== null && held.place !== place;
  const reading =
    input.threadsFetching || (threads === null && !input.threadsFailed);
  if (!moved && thread === undefined && reading) {
    waiting.current = held ?? { landing, place };
    return;
  }
  waiting.current = null;
  useBotTabLandingStore.getState().clear(input.botId);
  if (moved) return;
  if (thread === undefined) input.landChannel(null);
  else input.showThread(thread.threadId, null);
}

/**
 * Lands the tab where it was asked to from outside, once the thread list has
 * answered, since a thread opens by the post it hangs off. Each request is
 * spent once.
 *
 * A `thread` landing (a tapped push) shows the thread beside the channel, or
 * the channel. A `chat` landing (a chat search hit, a session link) names one
 * of the bot's chats, which is its channel, a thread, a thread's session or
 * its trunk session, each shown the way the tab shows it; an id that is none
 * of these lands nowhere, and the tab stays as it is. A `sender` landing
 * (a sender chip) shows the thread whose session sent beside the channel, or
 * the channel for any other session once the list being read has answered:
 * a thread the held list lacks may be in that answer. Where the person takes
 * the tab while it waits stands: the landing is then spent unlanded.
 */
function useSpendTabLanding(args: {
  readonly botId: string;
  readonly channelChatId: string | null;
  readonly trunkChatId: string;
  /** `null` while the list is read. */
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  /** A read of the list is in flight, over `threads` when they are held. */
  readonly threadsFetching: boolean;
  /** The last read of the list failed. */
  readonly threadsFailed: boolean;
  /** Where the tab is; a new value is a move, the person's or a landing's. */
  readonly place: BotTabPlace;
  readonly landChannel: (messageId: string | null) => void;
  readonly showThread: (threadId: string, messageId: string | null) => void;
  readonly openSession: BotSessionOpen;
  /** Shows one of the tab's views: it also leaves Threads. */
  readonly onViewChange: (view: BotTabView) => void;
}): void {
  const { botId, channelChatId, trunkChatId, threads } = args;
  const { threadsFetching, threadsFailed } = args;
  const { openSession, onViewChange, place } = args;
  const { landChannel: landOnChannel, showThread: showLandedThread } = args;
  // Where a landing puts the tab is nobody's own move: the route records it
  // over the entry the opener made, so one step back leaves it.
  const landChannel = useCallback(
    (messageId: string | null) => {
      useTracyPlaceStore.getState().markAutomaticMove();
      landOnChannel(messageId);
    },
    [landOnChannel],
  );
  const showThread = useCallback(
    (threadId: string, messageId: string | null) => {
      useTracyPlaceStore.getState().markAutomaticMove();
      showLandedThread(threadId, messageId);
    },
    [showLandedThread],
  );
  const landing = useBotTabLandingStore((state) =>
    Object.hasOwn(state.byBotId, botId) ? state.byBotId[botId] : null,
  );
  const waiting = useRef<WaitingLanding | null>(null);
  useEffect(() => {
    if (landing === null) return;
    // A sender's wait begins at the tab's place whether or not a list is held.
    if (landing.kind === "sender") {
      spendSenderLanding({
        botId,
        landing,
        threads,
        threadsFetching,
        threadsFailed,
        place,
        waiting,
        landChannel,
        showThread,
      });
      return;
    }
    if (threads === null) return;
    useBotTabLandingStore.getState().clear(botId);
    const { messageId } = landing;
    if (landing.kind === "thread") {
      if (landing.threadId === null) landChannel(messageId);
      else showThread(landing.threadId, messageId);
      return;
    }
    const { chatId } = landing;
    if (chatId === channelChatId) {
      landChannel(messageId);
      return;
    }
    if (threads.some((thread) => thread.threadId === chatId)) {
      showThread(chatId, messageId);
      return;
    }
    const session = threads.find((thread) => thread.sessionChatId === chatId);
    if (session !== undefined || chatId === trunkChatId) {
      // Threads shows in place of a session, so leave it, onto the channel
      // the session's Back returns to; a channel or thread landing leaves it
      // the same way through `landChannel` and `showThread`.
      useTracyPlaceStore.getState().markAutomaticMove();
      onViewChange("messages");
      openSession({
        chatId,
        threadId: session?.threadId ?? null,
        messageId,
        sendPostId: landing.sendPostId,
      });
    }
  }, [
    botId,
    channelChatId,
    landChannel,
    landing,
    onViewChange,
    openSession,
    place,
    showThread,
    threads,
    threadsFailed,
    threadsFetching,
    trunkChatId,
  ]);
}

/**
 * The top of a team's main bot's live channel (T67b): the setup the bot was
 * born from and how the team's host came; `null` for any other bot, and until
 * the environment list names the bot's team.
 */
function useChannelSetupHistory(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly bot: {
    readonly botId: string;
    readonly environmentId: string;
    readonly title: string;
  };
  readonly environment: {
    readonly label: string;
    readonly ownerKind: string;
  } | null;
  readonly isMain: boolean | null;
}): ReactNode {
  const { bot, environment } = input;
  const history = useTeamSetupHistory({
    client: input.client,
    hostId: input.hostId,
    botId: bot.botId,
    environmentId: bot.environmentId,
    team: environment?.ownerKind === "organization" && input.isMain === true,
  });
  if (history === null || environment === null) return null;
  return (
    <TeamSetupHistoryRows
      botTitle={bot.title}
      teamName={environment.label}
      history={history}
    />
  );
}

/**
 * Says whether the rail is drawn beside the channel, before the paint it would
 * otherwise be a frame late for. The rail draws only under Messages.
 */
function useRailDrawnReport(
  place: BotTabPlace,
  threadListSupported: boolean,
  onRailDrawn: (drawn: boolean) => void,
): void {
  const railDrawn =
    place.view === "messages" &&
    place.session === null &&
    !place.threadsShown &&
    (place.openMemory !== null ||
      place.searchResultsOpen ||
      (threadListSupported && place.openThread !== null));
  useLayoutEffect(() => {
    onRailDrawn(railDrawn);
    return () => onRailDrawn(false);
  }, [onRailDrawn, railDrawn]);
}

function BotTabContent(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly snapshot: BotSubscriptionSnapshot;
  readonly pausedReason: BotTabPausedReason | null;
  /** A re-open failed after an earlier one answered; the tab keeps that
   * answer and says the re-open failed. */
  readonly reopenError: string | null;
  readonly onReopen: () => void;
  readonly streamError: string | null;
  readonly snapshotFresh: boolean;
  readonly onRetry: () => void;
  readonly view: BotTabView;
  readonly onViewChange: (view: BotTabView) => void;
  /** The shell's level-2 form, which the channel's title follows. */
  readonly level2: MobileLevel2Form | null;
  /** The shell's tile count, which places the rail beside the channel. */
  readonly tiles: MobileTileCount | null;
  readonly onRailDrawn: (drawn: boolean) => void;
  /** Threads, from the column, shows in place of the channel's views. */
  readonly threadsView: BotThreadsViewState;
  /** The bot was deleted from its settings. */
  readonly onDeleted: () => void;
  /** `bot.list`'s main bots; `undefined` until the list answers. */
  readonly mainBotIds: MainBotIds | undefined;
}): ReactNode {
  const {
    botId,
    hostId,
    snapshot,
    pausedReason,
    reopenError,
    onReopen,
    streamError,
    snapshotFresh,
    onRetry,
    view,
    onViewChange,
    level2,
    tiles,
    onRailDrawn,
    threadsView,
    onDeleted,
    mainBotIds,
  } = props;
  const threadsShown = threadsView.shown;
  const client = useTabHostClient();
  const isMain = isMainBot(mainBotIds, snapshot.bot);
  const environments = useEnvironmentListQuery(true);
  const environment =
    environments.data?.environments.find(
      (entry) => entry.environmentId === snapshot.bot.environmentId,
    ) ?? null;
  const environmentLabel = environment?.label ?? snapshot.bot.environmentId;
  // Only a personal environment's bot may answer posts itself; a list not
  // read yet draws no reply-mode control.
  const personal = environment?.ownerKind === "user";
  const setupHistory = useChannelSetupHistory({
    client,
    hostId,
    bot: snapshot.bot,
    environment,
    isMain,
  });
  const botList = useBotListQuery(client, true);
  const environmentBots = useMemo(
    () =>
      botList.data === undefined
        ? null
        : environmentBotsOf(botList.data.bots, snapshot.bot.environmentId),
    [botList.data, snapshot.bot.environmentId],
  );
  // Who wrote each channel row.
  const directory = useEnvironmentMemberDirectory(
    snapshot.bot.environmentId,
    true,
  );
  const resolveMember = directory.resolve;
  const {
    openThread,
    openMemory,
    searchResultsOpen,
    setOpenThread,
    setOpenMemory,
    openMemoryInChannel,
    openExchange,
    exchanges: exchangeRail,
  } = useBotTabRail(botId, onViewChange);
  const memoryAccess = useMemo(
    (): BotMemoryAccess => ({
      hostId,
      botId,
      environmentId: snapshot.bot.environmentId,
      open: openMemoryInChannel,
    }),
    [botId, hostId, openMemoryInChannel, snapshot.bot.environmentId],
  );
  // A shared memory names the bot of the environment that wrote it.
  const botNameOf = useCallback(
    (otherBotId: string): string | null =>
      environmentBots?.find((bot) => bot.botId === otherBotId)?.title ?? null,
    [environmentBots],
  );
  // Any host with the list lists the threads; Activity names a thread's work
  // by it, and the label tells a thread's session from the bot's other chats.
  const threadListSupported =
    useHostMethodSupport(hostId, "bot.thread.list") === true;
  const threadList = useBotThreadListQuery(client, botId, {
    enabled: threadListSupported,
  });
  const threads = threadListSupported ? (threadList.data?.threads ?? null) : [];
  const {
    session,
    channelLanding,
    openSession,
    openTurn,
    closeSession,
    showChannel,
    landChannel,
    showThread,
  } = useBotTabSession({ botId, threads, onViewChange, setOpenThread });
  // Threads is the shell's, shown in place of the channel: a move too.
  const place = useMemo(
    (): BotTabPlace => ({
      view,
      threadsShown,
      session,
      openThread,
      openMemory,
      searchResultsOpen,
      channelLanding,
    }),
    [
      channelLanding,
      openMemory,
      openThread,
      searchResultsOpen,
      session,
      threadsShown,
      view,
    ],
  );
  useSpendTabLanding({
    botId,
    channelChatId: snapshot.bot.appConversationChatId,
    trunkChatId: snapshot.bot.trunkChatId,
    threads,
    threadsFetching: threadList.isFetching,
    threadsFailed: threadList.isError,
    place,
    landChannel,
    showThread,
    openSession,
    onViewChange,
  });
  useRailDrawnReport(place, threadListSupported, onRailDrawn);
  const activeTasks = useBotActiveTasks(snapshot.tasks, hostId, snapshotFresh);
  const showMessages = useCallback(() => {
    closeSession();
    onViewChange("messages");
  }, [closeSession, onViewChange]);
  const openSearch = useChannelSearchEntry({
    botId,
    hostId,
    channelShown: session === null && !threadsShown,
    onShow: showMessages,
  });
  // The channel's settings open beside it from the header's ⋮.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const toggleSettings = useCallback(
    () => setSettingsOpen((open) => !open),
    [],
  );
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  // A link inside the tab (the switcher's "Bot settings") opens them too.
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const owner = useBotOwner(environment, directory.members);
  const identity = useMemo(
    (): BotIdentity => ({
      botId,
      title: snapshot.bot.title,
      owner,
    }),
    [botId, owner, snapshot.bot.title],
  );
  const mentioned = useBotMentionDirectory({
    environmentId: snapshot.bot.environmentId,
    tasks: snapshot.tasks,
    environmentsRead: environments.data !== undefined,
    environment,
    resolveMember,
  });

  return (
    <BotMentionsContext value={mentioned}>
      <BotIdentityContext value={identity}>
        <BotSettingsOpenerContext value={openSettings}>
          <BotMemoryContext value={memoryAccess}>
            {/* Threads, shown by the shell, takes the place of the
                channel's views and of a session. */}
            {!threadsShown &&
              (session !== null ? (
                <BotSessionStatusDataContext
                  value={{
                    tasks: snapshot.tasks,
                    subscriptions: snapshot.notificationSubscriptions,
                  }}
                >
                  <BotSessionView
                    key={session.chatId}
                    botId={botId}
                    hostId={hostId}
                    botTitle={snapshot.bot.title}
                    session={session}
                    threads={threads}
                    resolveMember={resolveMember}
                    onClose={closeSession}
                    onOpenChannel={showChannel}
                    onOpenThread={showThread}
                  />
                </BotSessionStatusDataContext>
              ) : (
                <Tabs
                  value={view}
                  onValueChange={(next) => {
                    if (isTracyChannelView(next)) onViewChange(next);
                  }}
                  className="flex min-h-0 min-w-0 flex-1 flex-col gap-0"
                >
                  <BotChannelHeader
                    level2={level2}
                    botId={botId}
                    hostId={hostId}
                    threadsView={threadsView}
                    title={snapshot.bot.title}
                    isMain={isMain === true}
                    settingsOpen={settingsOpen}
                    onToggleSettings={toggleSettings}
                    onOpenSearch={openSearch}
                    activityCount={activeTasks.rows.length}
                  />
                  {streamError === null ? null : (
                    // A fatal close AFTER a snapshot: the last reading stays on
                    // screen, marked as such, and the retry sits on top of it.
                    <ErrorNotice
                      text={`Couldn't reach this bot: ${streamError}`}
                      onRetry={onRetry}
                      className="mx-4 mt-2"
                    />
                  )}
                  {reopenError === null ? null : (
                    <ErrorNotice
                      text={`Couldn't open this bot: ${reopenError}`}
                      onRetry={onReopen}
                      className="mx-4 mt-2"
                    />
                  )}
                  {pausedReason === null ? null : (
                    <PausedBanner
                      reason={pausedReason}
                      environmentLabel={environmentLabel}
                      onRetry={onReopen}
                    />
                  )}
                  <TabsContent
                    value="messages"
                    className="flex min-h-0 flex-1 flex-col"
                  >
                    <BotChannelView
                      botId={botId}
                      hostId={hostId}
                      boundHostId={snapshot.boundHost.hostId}
                      boundHostEpoch={snapshot.boundHost.epoch}
                      botTitle={snapshot.bot.title}
                      directive={snapshot.bot.directive}
                      appConversationChatId={snapshot.bot.appConversationChatId}
                      trunkChatId={snapshot.bot.trunkChatId}
                      resolveMember={resolveMember}
                      tasks={snapshot.tasks}
                      surfaceActions={snapshot.surfaceActions}
                      openThread={openThread}
                      onOpenThread={setOpenThread}
                      onOpenTurn={openTurn}
                      onOpenSession={openSession}
                      landOn={channelLanding}
                      openMemory={openMemory}
                      onOpenMemory={setOpenMemory}
                      environmentId={snapshot.bot.environmentId}
                      botNameOf={botNameOf}
                      environmentBots={environmentBots}
                      openExchange={openExchange}
                      exchangeRail={exchangeRail}
                      setupHistory={setupHistory}
                      tiles={tiles}
                    />
                  </TabsContent>
                  <TabsContent
                    value="activity"
                    className="flex min-h-0 flex-1 flex-col"
                  >
                    <BotActivityPage
                      roomFresh={activeTasks.roomFresh}
                      botId={botId}
                      hostId={hostId}
                      boundHere={snapshot.boundHost.isThisHost}
                      active={activeTasks}
                      notificationSubscriptions={
                        snapshot.notificationSubscriptions
                      }
                      trunkChatId={snapshot.bot.trunkChatId}
                      onOpenSession={openSession}
                      resolveMember={resolveMember}
                      threads={threads}
                    />
                  </TabsContent>
                </Tabs>
              ))}
            {settingsOpen ? (
              <BotChannelSettingsPanel
                bot={snapshot.bot}
                personal={personal}
                channelId={snapshot.bot.appConversationChatId}
                environmentBots={environmentBots}
                onClose={closeSettings}
                onDeleted={onDeleted}
              />
            ) : null}
          </BotMemoryContext>
        </BotSettingsOpenerContext>
      </BotIdentityContext>
    </BotMentionsContext>
  );
}

/** The bots of one environment, as the list names them. */
function environmentBotsOf(
  bots: ReadonlyArray<BotRecord>,
  environmentId: string,
): ReadonlyArray<BotRecord> {
  return bots.filter((bot) => bot.environmentId === environmentId);
}

/** The tab while anything about its host is unknown. */
function BotTabConnecting(): ReactNode {
  return (
    <div
      className="flex h-full items-center justify-center text-muted-foreground"
      aria-busy="true"
      data-testid="bot-tab-connecting"
    >
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
      />
    </div>
  );
}

/**
 * Reads again each read that failed, or `null` when none did: a host that
 * does not answer a team's setup answers the same however often it is asked,
 * so it is offered no Retry.
 */
function retryFailedReads(
  reads: ReadonlyArray<{
    readonly failed: boolean;
    readonly retry: () => void;
  }>,
): (() => void) | null {
  const failed = reads.filter((read) => read.failed);
  if (failed.length === 0) return null;
  return () => {
    for (const read of failed) read.retry();
  };
}

/** An error, with Retry unless `onRetry` is `null`: nothing to ask again. */
function ErrorNotice(props: {
  readonly text: string;
  readonly onRetry: (() => void) | null;
  readonly className: string;
}): ReactNode {
  return (
    <div
      role="alert"
      data-testid="bot-tab-error"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-ui-sm text-destructive",
        props.className,
      )}
    >
      <span>{props.text}</span>
      {props.onRetry === null ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onRetry}
        >
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * Slack's channel header: the bot's picture (its card on hover and click),
 * its name with the main bot's star, the ⋮ that opens the channel's settings,
 * and the channel's views under it. What the bot is for is the top of its channel; nothing else
 * sits here but, on the phone, Talk. A session started here is focused on
 * this channel. Activity's count is the tasks its list shows.
 */
function BotChannelHeader(props: {
  readonly level2: MobileLevel2Form | null;
  readonly botId: string;
  readonly hostId: string;
  readonly threadsView: BotThreadsViewState;
  readonly title: string;
  readonly isMain: boolean;
  readonly settingsOpen: boolean;
  readonly onToggleSettings: () => void;
  /** Opens the channel's search; `null` where the tab's host has none. */
  readonly onOpenSearch: (() => void) | null;
  /** How many tasks the Activity list shows. */
  readonly activityCount: number;
}): ReactNode {
  const { settingsOpen } = props;
  const background = useChannelBackground(props.botId);
  const expression = botExpressionOf(useBotActivity(props.botId));
  // With the keyboard up on a short viewport: the name row alone while the
  // channel's box has the focus, and nothing while a thread's does, since the
  // thread's own header is the identity row then. Only a box under this header
  // counts, so a parent's children are the header and the panes it heads.
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const focusOwner = useKeyboardFocusOwnerWithin(header?.parentElement ?? null);
  const threadHasFocus =
    focusOwner !== null &&
    focusOwner.closest("[data-bot-thread-panel]") !== null;
  // Focus goes back to the ⋮ when the settings close.
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(settingsOpen);
  useEffect(() => {
    if (wasOpenRef.current && !settingsOpen) settingsButtonRef.current?.focus();
    wasOpenRef.current = settingsOpen;
  }, [settingsOpen]);
  return (
    <header
      ref={setHeader}
      hidden={threadHasFocus}
      data-testid="bot-channel-header"
      data-channel-background={background.index}
      style={{ "--channel-tint": background.color } as CSSProperties}
      className={cn(
        "flex shrink-0 flex-col gap-1 px-4",
        focusOwner === null && "pt-3",
        background.className,
      )}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-2",
          focusOwner !== null && "min-h-11",
        )}
      >
        <BotIdentityTrigger>
          <button
            type="button"
            aria-label={props.title}
            className="shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
            data-testid="bot-tab-avatar"
          >
            <ExpressiveBotAvatar size="sm" expression={expression} />
          </button>
        </BotIdentityTrigger>
        <BotChannelTitle
          level2={props.level2}
          title={props.title}
          activeBotId={props.botId}
          hostId={props.hostId}
          threadsView={props.threadsView}
        />
        {props.isMain ? (
          <MainBotBadge testId="bot-tab-main" tone="muted" />
        ) : null}
        {props.onOpenSearch === null ? null : (
          <TooltipWrapper
            label={`Search in ${props.title} ${formatChordForDisplay("mod+f")}`}
            side="bottom"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Search in ${props.title}`}
              data-testid="bot-channel-search-open"
              className="ml-auto"
              onClick={props.onOpenSearch}
            >
              <Search aria-hidden="true" />
            </Button>
          </TooltipWrapper>
        )}
        <Button
          ref={settingsButtonRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Channel settings"
          aria-expanded={settingsOpen}
          data-testid="bot-channel-settings-open"
          className={props.onOpenSearch === null ? "ml-auto" : undefined}
          onClick={props.onToggleSettings}
        >
          <EllipsisVertical aria-hidden="true" />
        </Button>
      </div>
      <TabsList
        hidden={focusOwner !== null}
        variant="line"
        aria-label="Channel view"
      >
        <TabsTrigger value="messages" data-testid="bot-tab-view-messages">
          Messages
        </TabsTrigger>
        <TabsTrigger value="activity" data-testid="bot-tab-view-activity">
          Activity
          <UnreadCountBadge
            count={props.activityCount}
            size="xs"
            testId="bot-tab-activity-count"
            corner={null}
            noun="active"
          />
        </TabsTrigger>
      </TabsList>
    </header>
  );
}

/**
 * The paused banner: why no host can run the bot's turns now, with no
 * machine named, and Retry where asking again can change the answer.
 */
function PausedBanner(props: {
  readonly reason: BotTabPausedReason;
  readonly environmentLabel: string;
  readonly onRetry: () => void;
}): ReactNode {
  const copy = botPausedCopy(props.reason, props.environmentLabel);
  return (
    <div
      role="status"
      data-testid="bot-tab-paused"
      data-reason={props.reason}
      className="mx-4 mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-info/30 bg-info/10 px-4 py-3 text-ui-sm text-info-foreground"
    >
      <span>{copy.text}</span>
      {copy.retry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onRetry}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}
