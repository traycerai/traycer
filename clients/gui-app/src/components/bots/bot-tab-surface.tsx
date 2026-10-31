import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EllipsisVertical } from "lucide-react";
import type { BotOpenResponse } from "@traycer/protocol/host/bot/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { BotsUnavailableNotice } from "@/components/bots/bots-unavailable-notice";
import {
  useBotSubscriptionForHost,
  type BotSubscriptionSnapshot,
} from "@/hooks/bots/use-bot-subscription";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useBotMarkChannelRead } from "@/hooks/bots/use-bot-read-cursor";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { useBotListChangedSubscriptionForHost } from "@/hooks/bots/use-bot-list-changed-subscription";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentMemberDirectory } from "@/hooks/bots/use-environment-members-query";
import { useBotOpenMutation } from "@/hooks/bots/use-bot-mutations";
import { useTeamSetups } from "@/hooks/bots/use-team-setups";
import { botTabRouteOf } from "@/lib/bots/bot-tab-route";
import {
  TeamSetupChannel,
  TeamSetupHistoryRows,
} from "@/components/bots/team-setup-channel";
import { useTeamSetupHistory } from "@/hooks/bots/use-team-setup-history";
import { buildHomeBotsModel } from "@/lib/home-bots/bots-model";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import {
  BotChannelView,
  type BotChannelLanding,
} from "@/components/bots/bot-channel-view";
import {
  memoryRailOver,
  sessionTargetOfTurn,
  useBotOpenThreadStore,
  useBotRail,
  type BotOpenMemory,
  type BotOpenThread,
  type BotSessionOpen,
  type BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";
import {
  BotSessionView,
  type BotOpenSession,
} from "@/components/bots/bot-session-view";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import { BotChannelSidebar } from "@/components/bots/bot-channel-sidebar";
import { BotResizablePane } from "@/components/bots/bot-resizable-pane";
import { BotActivityPage } from "@/components/bots/bot-activity-page";
import { BotThreadsPage } from "@/components/bots/bot-threads-page";
import { useBotThreadListQuery } from "@/hooks/bots/use-bot-thread-list-query";
import { useBotActivitySummary } from "@/hooks/bots/use-bot-activity-summary";
import {
  activityLabelParts,
  type BotActivityLabelPart,
} from "@/lib/bots/bot-activity-model";
import { BotChannelSettingsPanel } from "@/components/bots/bot-settings-panel";
import {
  BotIdentityContext,
  type BotIdentity,
  type BotOwner,
} from "@/components/bots/bot-identity-context";
import {
  BotMemoryContext,
  type BotMemoryAccess,
} from "@/components/bots/bot-memory-context";
import { BotAvatar } from "@/components/bots/bot-avatars";
import { BotIdentityTrigger } from "@/components/bots/bot-identity-popover";
import { MainBotBadge } from "@/components/bots/main-bot-badge";
import { botMemberName } from "@/lib/bots/bot-member-names";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  BotMentionsContext,
  type BotMentioned,
} from "@/components/bots/bot-mentions-context";
import { isMainBot, type MainBotIds } from "@/lib/bots/bot-main";
import {
  botPausedCopy,
  botTabOpenState,
  type BotTabPausedReason,
} from "@/components/bots/bot-tab-open-state";
import { cn } from "@/lib/utils";

type BotTabView = "messages" | "activity" | "threads";

function isBotTabView(value: string): value is BotTabView {
  return value === "messages" || value === "activity" || value === "threads";
}

/**
 * A bot's tab (Tracy Bots). The person never picks the machine a bot runs
 * on: the tab opens through the host it was created on (this host, from
 * Home), asks it `bot.open`, and stays there whatever the answer (T65) -
 * the tab's host serves the bot's channel, its threads and what the bot is
 * doing, whether it runs the bot (bound here, or claimed here because its
 * host was away) or another host does; the bot's host only runs its turns.
 * When no host can run them the paused banner says so, naming no machine,
 * above the channel, and a post waits for delivery. The background work
 * under Activity alone is the bot's host's to show.
 *
 * A team's main bot that is still to be set up (`useTeamSetups`, T67) has no
 * row yet: its tab shows the channel where the team is set up
 * (`TeamSetupChannel`) and opens nothing, until the bot exists under the
 * same id. Until the lists say which it is - the bot and environment lists,
 * and the onboarding of a team with no bot - the tab neither opens nor shows
 * a channel.
 *
 * Laid out as Slack is (decision 41): the person's environments and their
 * bots as channels down the side, and the bot's channel beside them, with
 * Slack's tab strip under its header - Messages, Activity (what the bot is
 * doing and did, its label counting it) and Threads (decision 115) - and its
 * settings behind the header's ⋮.
 *
 * Bound to ONE host at a time through `TabHostProvider`; everything below
 * reads that host - the stream, the conversation list, every write. A tab
 * left on a host this client can no longer dial is moved back to the app's
 * host by the next open from Home (`HomeBotRow`), which may read that host;
 * the tab itself never reads the app-wide host. While anything about that
 * host is unknown - its methods, `bot.open`'s answer, the stream - the tab
 * shows its connecting state, never nothing.
 */
export function BotTabSurface(props: {
  readonly botId: string;
  readonly hostId: string;
}): ReactNode {
  const { botId, hostId } = props;
  // A tab is created only from Home's bots band, which draws nothing until
  // the host advertises `bot.list`; a RESTORED tab (the store persists per
  // window) meets whatever that host advertises now. `bot.open` is the
  // newest method of the `bot.*` block, so its presence stands for every
  // write the tab offers; without it the tab shows the update notice and no
  // control that would call a method the host lacks.
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
      <BotTabRoute botId={botId} hostId={hostId} />
    </TabHostProvider>
  );
}

/**
 * Whether the tab's bot is a listed bot, whose channel the tab opens, or a
 * team's main bot still to be set up, whose setup it shows. A bot that is
 * neither is a listed bot's tab all the same, which closes itself once the
 * list does not carry it.
 *
 * A bot this tab has shown listed is that bot until a list without it closes
 * the tab. Any other bot may be a team's main bot still to be set up, so it
 * is never taken for a deleted one on a list older than the tab or than the
 * newest setup read: the list is read again first, so a main bot created
 * since is found rather than its tab closed. Only lists that were read say
 * what is absent: while either list has not answered or its last read
 * failed, or a team with no bot cannot be told apart (`unresolved`: its
 * setup read failed, or the host does not answer it), the tab says the
 * channel could not be loaded and, when a read failed, offers to read it
 * again (`botTabRouteOf`).
 */
function BotTabRoute(props: {
  readonly botId: string;
  readonly hostId: string;
}): ReactNode {
  const { botId, hostId } = props;
  const client = useTabHostClient();
  const botList = useBotListQuery(client, true);
  const environments = useEnvironmentListQuery(client, true);
  const listed = botList.data?.bots.some((bot) => bot.botId === botId) ?? false;
  const groups = useMemo(
    () =>
      botList.data === undefined || environments.data === undefined
        ? null
        : buildHomeBotsModel({
            environments: environments.data.environments,
            bots: botList.data.bots,
            mainBotIds: botList.data.mainBotIds,
          }).groups,
    [botList.data, environments.data],
  );
  const teamSetups = useTeamSetups({ client, hostId, groups });
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
  if (route.kind === "connecting") return <BotTabConnecting />;
  if (route.kind === "setup") {
    return (
      <TeamSetupChannel setup={route.setup} client={client} hostId={hostId} />
    );
  }
  if (route.kind === "unresolved") {
    return (
      <ErrorNotice
        text="Couldn't load this channel."
        onRetry={retryFailedReads([
          { failed: botListFailed, retry: () => void refetchList() },
          {
            failed: environmentsFailed,
            retry: () => void environments.refetch(),
          },
          { failed: teamSetups.retryable, retry: teamSetups.retry },
        ])}
        className="m-4"
      />
    );
  }
  return <BotTabBody {...props} />;
}

function BotTabBody(props: {
  readonly botId: string;
  readonly hostId: string;
}): ReactNode {
  const { botId, hostId } = props;
  const subscription = useBotSubscriptionForHost({
    botId,
    hostId,
    enabled: true,
  });
  const client = useTabHostClient();
  const closeBotTab = useBotTabsStore((s) => s.closeBotTab);
  const setBotTabTitle = useBotTabsStore((s) => s.setBotTabTitle);
  const [view, setView] = useState<BotTabView>("messages");

  const botList = useBotListQuery(client, true);
  const listedBots = botList.data?.bots;

  // Open once per (bot, tab host) - this body remounts with the host - and
  // again on Retry or when the tab comes back into view. A mutation, not a
  // query: an open may claim the bot onto this host, which a background
  // refetch must never do on its own. The last answer is HELD across a
  // re-open, so asking again never blanks a tab that is serving; a failed
  // re-open is shown above it instead.
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

  const openState = botTabOpenState({
    response: answer,
    error: answer === undefined ? openError : null,
  });

  // A deleted bot has no tab: the store removal closes it everywhere. Two
  // signals say so - the stream's `deleted` frame, and a `bot.list` answer
  // that no longer carries the bot, which is how a delete made while this
  // stream was down reaches the tab, and how a `bot.open` that found no bot
  // does (every open invalidates the list).
  // A teammate's rename, claim or delete reaches the list (and so this tab)
  // without waiting for focus, through the tab's own host.
  useBotListChangedSubscriptionForHost(hostId, true);
  const goneFromList =
    listedBots !== undefined && !listedBots.some((bot) => bot.botId === botId);
  useEffect(() => {
    if (subscription.deleted || goneFromList) closeBotTab(botId);
  }, [botId, closeBotTab, goneFromList, subscription.deleted]);

  // The header tab shows the stream's title, which a rename elsewhere moves.
  const snapshotTitle = subscription.snapshot?.bot.title ?? null;
  useEffect(() => {
    if (snapshotTitle !== null) setBotTabTitle(botId, snapshotTitle);
  }, [botId, setBotTabTitle, snapshotTitle]);

  // The host re-sends a snapshot only for changes IT made; a bot rebound or
  // edited from another host reaches this client on the next subscribe, so
  // the tab asks again - and opens again, since the bot's host may have come
  // back or gone away - when it comes back into view: the window becoming
  // visible, and this tab becoming the active one (inactive tabs stay
  // mounted, hidden).
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
  // Only the tab in view re-opens when the window returns: an open can claim
  // the bot onto this host, and a hidden tab is not a person asking for it.
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
    return (
      <ErrorNotice
        text={`Couldn't open this bot: ${openState.message}`}
        onRetry={reopen}
        className="m-4"
      />
    );
  }
  const snapshot = subscription.snapshot;
  if (snapshot === null && subscription.error !== null) {
    return (
      <ErrorNotice
        text={`Couldn't reach this bot: ${subscription.error}`}
        onRetry={resubscribe}
        className="m-4"
      />
    );
  }
  if (snapshot === null || openState.kind === "opening") {
    return <BotTabConnecting />;
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
      onRetry={resubscribe}
      view={view}
      onViewChange={setView}
      mainBotIds={botList.data?.mainBotIds}
    />
  );
}

/**
 * The rail's one slot - a thread or the bot's memory - held in its store,
 * above the views, so it survives a switch between the channel's tabs; and
 * the ways Activity, Threads and the bot's profile card open it beside the
 * channel, switching to Messages.
 */
function useBotTabRail(
  botId: string,
  onViewChange: (view: BotTabView) => void,
): {
  readonly openThread: BotOpenThread | null;
  readonly openMemory: BotOpenMemory | null;
  readonly setOpenThread: (open: BotOpenThread | null) => void;
  readonly setOpenMemory: (open: BotOpenMemory | null) => void;
  readonly openPostInChannel: (open: BotOpenThread) => void;
  readonly openMemoryInChannel: () => void;
} {
  const rail = useBotRail(botId);
  const setRail = useBotOpenThreadStore((s) => s.setRail);
  const openThread = rail?.kind === "thread" ? rail : null;
  const openMemory = rail?.kind === "memory" ? rail : null;
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
  // A post or a thread, from Activity or Threads: its thread opens beside the
  // channel.
  const openPostInChannel = useCallback(
    (open: BotOpenThread) => {
      setOpenThread(open);
      onViewChange("messages");
    },
    [onViewChange, setOpenThread],
  );
  return {
    openThread,
    openMemory,
    setOpenThread,
    setOpenMemory,
    openPostInChannel,
    openMemoryInChannel,
  };
}

/**
 * The bot's session shown in place of the channel's views (Tracy Bots T93),
 * and where the channel lands once it is back. A receipt, a check-in's link
 * or a thread's "Thread session" opens a session; each open is a new visit,
 * so the same turn opened again lands again. The session's links show the
 * channel - on a post, or with a thread beside it - in Messages; its back
 * button returns to the view it was opened from, the channel where it was.
 * The channel lands on a post once: leaving Messages drops the landing.
 */
function useBotTabSession(args: {
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly onViewChange: (view: BotTabView) => void;
  readonly setOpenThread: (open: BotOpenThread | null) => void;
}): {
  readonly session: BotOpenSession | null;
  readonly channelLanding: BotChannelLanding | null;
  readonly openSession: BotSessionOpen;
  readonly openTurn: BotTurnOpen;
  readonly closeSession: () => void;
  readonly changeView: (view: BotTabView) => void;
  readonly showChannel: (messageId: string | null) => void;
  readonly landChannel: (messageId: string | null) => void;
  readonly showThread: (threadId: string, messageId: string | null) => void;
} {
  const { threads, onViewChange, setOpenThread } = args;
  const [shown, setShown] = useState<{
    readonly session: BotOpenSession | null;
    readonly channelLanding: BotChannelLanding | null;
    readonly visits: number;
  }>({ session: null, channelLanding: null, visits: 0 });
  const openSession = useCallback<BotSessionOpen>((target) => {
    setShown((previous) => {
      const visit = previous.visits + 1;
      return {
        session: {
          chatId: target.chatId,
          threadId: target.threadId,
          landOn:
            target.messageId === null
              ? null
              : {
                  messageId: target.messageId,
                  sendPostId: target.sendPostId,
                  visit,
                },
        },
        channelLanding: null,
        visits: visit,
      };
    });
  }, []);
  const openTurn = useCallback<BotTurnOpen>(
    (ref, sendPostId) => openSession(sessionTargetOfTurn(ref, sendPostId)),
    [openSession],
  );
  const closeSession = useCallback(
    () => setShown((previous) => ({ ...previous, session: null })),
    [],
  );
  // The channel shows, landed on a message of it or of the thread beside it.
  const showLanded = useCallback(
    (landOn: Omit<BotChannelLanding, "visit"> | null) => {
      setShown((previous) => {
        const visit = previous.visits + 1;
        return {
          session: null,
          channelLanding: landOn === null ? null : { ...landOn, visit },
          visits: visit,
        };
      });
      onViewChange("messages");
    },
    [onViewChange],
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
  // Leaving Messages spends the channel's landing: the channel mounts again
  // when Messages shows, and must not land on that post a second time.
  const changeView = useCallback(
    (view: BotTabView) => {
      if (view !== "messages") {
        setShown((previous) =>
          previous.channelLanding === null
            ? previous
            : { ...previous, channelLanding: null },
        );
      }
      onViewChange(view);
    },
    [onViewChange],
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
    session: shown.session,
    channelLanding: shown.channelLanding,
    openSession,
    openTurn,
    closeSession,
    changeView,
    showChannel,
    landChannel,
    showThread,
  };
}

/**
 * Lands the tab where it was asked to from outside (a tapped push): the
 * thread beside the channel, or the channel, once the thread list has
 * answered, since a thread opens by the post it hangs off. Each request is
 * spent once.
 */
function useSpendTabLanding(args: {
  readonly botId: string;
  /** `null` while the list is read. */
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly landChannel: (messageId: string | null) => void;
  readonly showThread: (threadId: string, messageId: string | null) => void;
}): void {
  const { botId, threads, landChannel, showThread } = args;
  const landing = useBotTabLandingStore((state) =>
    Object.hasOwn(state.byBotId, botId) ? state.byBotId[botId] : null,
  );
  useEffect(() => {
    if (landing === null || threads === null) return;
    useBotTabLandingStore.getState().clear(botId);
    if (landing.threadId === null) {
      landChannel(landing.messageId);
    } else {
      showThread(landing.threadId, landing.messageId);
    }
  }, [botId, landChannel, landing, showThread, threads]);
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
  readonly onRetry: () => void;
  readonly view: BotTabView;
  readonly onViewChange: (view: BotTabView) => void;
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
    onRetry,
    view,
    onViewChange,
    mainBotIds,
  } = props;
  const client = useTabHostClient();
  const isMain = isMainBot(mainBotIds, snapshot.bot);
  const environments = useEnvironmentListQuery(client, true);
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
  // Who wrote each channel row. A host without the method shows the other
  // members by id.
  const membersSupported =
    useHostMethodSupport(hostId, "environment.members") === true;
  const directory = useEnvironmentMemberDirectory(
    client,
    snapshot.bot.environmentId,
    membersSupported,
  );
  const resolveMember = directory.resolve;
  const {
    openThread,
    openMemory,
    setOpenThread,
    setOpenMemory,
    openPostInChannel,
    openMemoryInChannel,
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
    changeView,
    showChannel,
    landChannel,
    showThread,
  } = useBotTabSession({ threads, onViewChange, setOpenThread });
  useSpendTabLanding({ botId, threads, landChannel, showThread });
  const openActivity = useCallback(() => changeView("activity"), [changeView]);
  const activitySummary = useBotActivitySummary({
    botId,
    trunkChatId: snapshot.bot.trunkChatId,
    tasks: snapshot.tasks,
    activity: snapshot.activity,
    threads,
  });
  // The channel's settings open beside it from the header's ⋮.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const toggleSettings = useCallback(
    () => setSettingsOpen((open) => !open),
    [],
  );
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const markRead = useBotMarkChannelRead(
    botId,
    hostId,
    snapshot.bot.appConversationChatId,
  );
  const viewer = useAuthStore((s) => s.profile);
  const owner = useMemo((): BotOwner | null => {
    if (environment === null) return null;
    if (environment.ownerKind === "organization") {
      return {
        kind: "team",
        name: environment.label,
        members: directory.members,
      };
    }
    // A personal environment the list names is the viewer's own.
    if (viewer === null) return null;
    const name = viewer.userName.trim();
    return {
      kind: "person",
      userId: viewer.userId,
      name: name.length > 0 ? name : "You",
      avatarUrl: viewer.avatarUrl ?? null,
    };
  }, [directory.members, environment, viewer]);
  const identity = useMemo(
    (): BotIdentity => ({
      botId,
      title: snapshot.bot.title,
      owner,
    }),
    [botId, owner, snapshot.bot.title],
  );
  // A mention names the viewer, or a member the directory lists; anyone
  // else's token stays as written.
  const mentioned = useCallback(
    (userId: string): BotMentioned | null => {
      if (viewer !== null && viewer.userId === userId) {
        return {
          name: botMemberName(userId, viewer, resolveMember),
          self: true,
        };
      }
      const member = resolveMember(userId);
      if (member === null) return null;
      return { name: member.displayName ?? "member", self: false };
    },
    [resolveMember, viewer],
  );

  return (
    <BotMentionsContext value={mentioned}>
      <BotIdentityContext value={identity}>
        <BotMemoryContext value={memoryAccess}>
          <div className="@container flex h-full min-h-0" data-testid="bot-tab">
            <BotResizablePane
              pane="sidebar"
              edge="right"
              label="Resize channels"
              className="hidden min-h-0 w-(--bot-pane-width) max-w-[40%] shrink-0 flex-col border-r border-border/60 @3xl:flex"
              handleClassName=""
              testId="bot-channel-sidebar-pane"
            >
              <BotChannelSidebar activeBotId={botId} hostId={hostId} />
            </BotResizablePane>
            <div className="relative flex min-h-0 min-w-0 flex-1">
              {session !== null ? (
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
              ) : (
                <Tabs
                  value={view}
                  onValueChange={(next) => {
                    if (isBotTabView(next)) changeView(next);
                  }}
                  className="flex min-h-0 min-w-0 flex-1 flex-col gap-0"
                >
                  <BotChannelHeader
                    title={snapshot.bot.title}
                    isMain={isMain === true}
                    settingsOpen={settingsOpen}
                    onToggleSettings={toggleSettings}
                    onMarkRead={markRead}
                    activityLabel={activityLabelParts({
                      stopped: activitySummary.stopped.length,
                      running: activitySummary.running.length,
                      tasks: activitySummary.tasks,
                    })}
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
                      onOpenActivity={openActivity}
                      setupHistory={setupHistory}
                    />
                  </TabsContent>
                  <TabsContent
                    value="activity"
                    className="flex min-h-0 flex-1 flex-col"
                  >
                    <BotActivityPage
                      botId={botId}
                      hostId={hostId}
                      boundHost={snapshot.boundHost}
                      channelId={snapshot.bot.appConversationChatId}
                      tasks={snapshot.tasks}
                      notificationSubscriptions={
                        snapshot.notificationSubscriptions
                      }
                      stoppedNotificationWatches={
                        snapshot.stoppedNotificationWatches
                      }
                      resolveMember={resolveMember}
                      summary={activitySummary}
                      threads={threads}
                      onOpenPost={openPostInChannel}
                      onOpenTurn={openTurn}
                    />
                  </TabsContent>
                  <TabsContent
                    value="threads"
                    className="flex min-h-0 flex-1 flex-col"
                  >
                    <BotThreadsPage
                      botId={botId}
                      hostId={hostId}
                      threadList={threadListSupported ? threadList : null}
                      onOpenPost={openPostInChannel}
                    />
                  </TabsContent>
                </Tabs>
              )}
              {settingsOpen ? (
                <BotChannelSettingsPanel
                  bot={snapshot.bot}
                  isMain={isMain}
                  personal={personal}
                  channelId={snapshot.bot.appConversationChatId}
                  environmentBots={environmentBots}
                  onClose={closeSettings}
                />
              ) : null}
            </div>
          </div>
        </BotMemoryContext>
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
 * its name with the main bot's star, the ⋮ that opens the channel's settings
 * (and marks it read, where the host keeps read cursors), and the channel's views
 * under it. What the bot is for is the top of its channel; nothing else
 * sits here. Activity's label is the bot's indicator: what stopped, in red
 * and first, what runs and the tasks it tracks.
 */
function BotChannelHeader(props: {
  readonly title: string;
  readonly isMain: boolean;
  readonly settingsOpen: boolean;
  readonly onToggleSettings: () => void;
  /** Clears the channel's bold; `null` where the host keeps no read cursors, and the ⋮ opens the settings directly. */
  readonly onMarkRead: (() => void) | null;
  readonly activityLabel: ReadonlyArray<BotActivityLabelPart>;
}): ReactNode {
  const { settingsOpen } = props;
  // Focus goes back to the ⋮ when the settings close.
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(settingsOpen);
  useEffect(() => {
    if (wasOpenRef.current && !settingsOpen) settingsButtonRef.current?.focus();
    wasOpenRef.current = settingsOpen;
  }, [settingsOpen]);
  return (
    <header className="flex shrink-0 flex-col gap-1 px-4 pt-3">
      <div className="flex min-w-0 items-center gap-2">
        <BotIdentityTrigger>
          <button
            type="button"
            aria-label={props.title}
            className="shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
            data-testid="bot-tab-avatar"
          >
            <BotAvatar size="sm" />
          </button>
        </BotIdentityTrigger>
        <h1
          className="min-w-0 truncate text-ui-md font-bold text-foreground"
          data-testid="bot-tab-title"
        >
          {props.title}
        </h1>
        {props.isMain ? (
          <MainBotBadge testId="bot-tab-main" tone="muted" />
        ) : null}
        {props.onMarkRead === null ? (
          <Button
            ref={settingsButtonRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Channel settings"
            aria-expanded={settingsOpen}
            data-testid="bot-channel-settings-open"
            className="ml-auto"
            onClick={props.onToggleSettings}
          >
            <EllipsisVertical aria-hidden="true" />
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                ref={settingsButtonRef}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Channel actions"
                data-testid="bot-channel-settings-open"
                className="ml-auto"
              >
                <EllipsisVertical aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                data-testid="bot-channel-mark-read"
                onSelect={props.onMarkRead}
              >
                Mark as read
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="bot-channel-settings-item"
                onSelect={props.onToggleSettings}
              >
                {settingsOpen ? "Close channel settings" : "Channel settings"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <TabsList variant="line" aria-label="Channel view">
        <TabsTrigger value="messages" data-testid="bot-tab-view-messages">
          Messages
        </TabsTrigger>
        <TabsTrigger value="activity" data-testid="bot-tab-view-activity">
          Activity
          {props.activityLabel.map((part) => (
            <span
              key={part.kind}
              data-testid={`bot-tab-activity-${part.kind}`}
              className={cn(
                "font-normal",
                part.kind === "stopped"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {` · ${part.text}`}
            </span>
          ))}
        </TabsTrigger>
        <TabsTrigger value="threads" data-testid="bot-tab-view-threads">
          Threads
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
