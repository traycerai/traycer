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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { BotsUnavailableNotice } from "@/components/bots/bots-unavailable-notice";
import {
  useConnectableHostIds,
  type ConnectableHosts,
} from "@/hooks/host/use-connectable-host-ids";
import {
  useBotSubscriptionForHost,
  type BotSubscriptionSnapshot,
} from "@/hooks/bots/use-bot-subscription";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import { useBotListChangedSubscriptionForHost } from "@/hooks/bots/use-bot-list-changed-subscription";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentMemberDirectory } from "@/hooks/bots/use-environment-members-query";
import { useBotOpenMutation } from "@/hooks/bots/use-bot-mutations";
import { useHostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import { useTeamOnboardingGate } from "@/hooks/bots/use-team-onboarding-gate";
import { BotOnboardingCard } from "@/components/home/bots/bot-onboarding-card";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { BotChannelView } from "@/components/bots/bot-channel-view";
import {
  useBotOpenThreadStore,
  useBotRail,
  type BotOpenThread,
  type BotOpenTurn,
} from "@/stores/bots/bot-open-thread-store";
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
import { BotAvatar } from "@/components/bots/bot-avatars";
import { BotIdentityTrigger } from "@/components/bots/bot-identity-popover";
import { MainBotBadge } from "@/components/bots/main-bot-badge";
import { useAuthStore } from "@/stores/auth/auth-store";
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
 * While its team's onboarding locks the team's chat (`teamOnboardingGate`,
 * as the sidebar's channel rows read it) the tab is not opened and shows the
 * onboarding instead of the channel, so a restored tab or a direct
 * navigation is no way around the lock. Until the gate is known - the bot
 * and environment lists and the onboarding read answered - the tab neither
 * opens nor shows the channel.
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
  const connectable = useConnectableHostIds();
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
      <BotTabBody botId={botId} hostId={hostId} connectable={connectable} />
    </TabHostProvider>
  );
}

function BotTabBody(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly connectable: ConnectableHosts;
}): ReactNode {
  const { botId, hostId, connectable } = props;
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
  const environments = useEnvironmentListQuery(client, true);
  const onboarding = useBotTeamOnboarding(botId, hostId, botList, environments);
  const clear = onboarding.kind === "clear";

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
    if (clear) reopen();
  }, [clear, reopen]);

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
    if (clear) reopen();
    resubscribe();
  }, [clear, reopen, resubscribe]);
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

  if (onboarding.kind === "locked") {
    return (
      <div
        className="flex h-full justify-center overflow-y-auto p-4"
        data-testid="bot-tab-onboarding"
      >
        <div className="flex w-full max-w-md flex-col">
          <LockedTeamOnboarding
            {...onboarding.team}
            connectable={connectable}
          />
        </div>
      </div>
    );
  }
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
  if (
    onboarding.kind === "settling" ||
    snapshot === null ||
    openState.kind === "opening"
  ) {
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
 * The rail's one slot - a thread or one turn - held in its store, above the
 * views, so it survives a switch between the channel's tabs; and the ways
 * Activity and Threads open it beside the channel, switching to Messages.
 */
function useBotTabRail(
  botId: string,
  onViewChange: (view: BotTabView) => void,
): {
  readonly openThread: BotOpenThread | null;
  readonly openTurn: BotOpenTurn | null;
  readonly setOpenThread: (open: BotOpenThread | null) => void;
  readonly setOpenTurn: (open: BotOpenTurn | null) => void;
  readonly openPostInChannel: (open: BotOpenThread) => void;
  readonly openTurnInChannel: (open: BotOpenTurn) => void;
} {
  const rail = useBotRail(botId);
  const setRail = useBotOpenThreadStore((s) => s.setRail);
  const openThread = rail?.kind === "thread" ? rail : null;
  const openTurn = rail?.kind === "turn" ? rail : null;
  const setOpenThread = useCallback(
    (open: BotOpenThread | null) =>
      setRail(botId, open === null ? null : { kind: "thread", ...open }),
    [botId, setRail],
  );
  const setOpenTurn = useCallback(
    (open: BotOpenTurn | null) =>
      setRail(botId, open === null ? null : { kind: "turn", ...open }),
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
  // A check-in's turn, from Activity: it opens beside the channel, in place
  // of whatever the rail held, with nothing to go back to.
  const openTurnInChannel = useCallback(
    (open: BotOpenTurn) => {
      setOpenTurn(open);
      onViewChange("messages");
    },
    [onViewChange, setOpenTurn],
  );
  return {
    openThread,
    openTurn,
    setOpenThread,
    setOpenTurn,
    openPostInChannel,
    openTurnInChannel,
  };
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
    openTurn,
    setOpenThread,
    setOpenTurn,
    openPostInChannel,
    openTurnInChannel,
  } = useBotTabRail(botId, onViewChange);
  const openActivity = useCallback(
    () => onViewChange("activity"),
    [onViewChange],
  );
  // Any host with the list lists the threads; Activity names a thread's work
  // by it, and the label tells a thread's session from the bot's other chats.
  const threadListSupported =
    useHostMethodSupport(hostId, "bot.thread.list") === true;
  const threadList = useBotThreadListQuery(client, botId, {
    enabled: threadListSupported,
  });
  const threads = threadListSupported ? (threadList.data?.threads ?? null) : [];
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

  return (
    <BotIdentityContext value={identity}>
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
          <Tabs
            value={view}
            onValueChange={(next) => {
              if (isBotTabView(next)) onViewChange(next);
            }}
            className="flex min-h-0 min-w-0 flex-1 flex-col gap-0"
          >
            <BotChannelHeader
              title={snapshot.bot.title}
              isMain={isMain === true}
              settingsOpen={settingsOpen}
              onToggleSettings={toggleSettings}
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
                openThread={openThread}
                onOpenThread={setOpenThread}
                openTurn={openTurn}
                onOpenTurn={setOpenTurn}
                onOpenActivity={openActivity}
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
                notificationSubscriptions={snapshot.notificationSubscriptions}
                stoppedNotificationWatches={snapshot.stoppedNotificationWatches}
                resolveMember={resolveMember}
                summary={activitySummary}
                threads={threads}
                onOpenPost={openPostInChannel}
                onOpenTurn={openTurnInChannel}
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
    </BotIdentityContext>
  );
}

/** A team whose onboarding locks its chat, as its card reads it. */
type LockedTeam = {
  readonly environmentId: string;
  readonly teamName: string;
  readonly botCount: number;
};

/**
 * Whether the bot's team's onboarding keeps its channel closed: the same
 * gate, on the same host's read, as the sidebar's channel rows. `settling`
 * until the lists that name the bot's team and the team's onboarding read
 * have answered; a list that failed never locks, as a failed read does not.
 */
type BotTabOnboarding =
  | { readonly kind: "settling" }
  | { readonly kind: "locked"; readonly team: LockedTeam }
  | { readonly kind: "clear" };

function useBotTeamOnboarding(
  botId: string,
  hostId: string,
  botList: {
    readonly status: "pending" | "error" | "success";
    readonly data: { readonly bots: ReadonlyArray<BotRecord> } | undefined;
  },
  environmentList: {
    readonly status: "pending" | "error" | "success";
    readonly data:
      | { readonly environments: ReadonlyArray<EnvironmentDescriptor> }
      | undefined;
  },
): BotTabOnboarding {
  const client = useTabHostClient();
  const { environment, botCount } = botTeamOf(
    botId,
    botList.data?.bots ?? [],
    environmentList.data?.environments ?? [],
  );
  // Read only for a team the list names: anything else is never locked.
  const { gate } = useTeamOnboardingGate({
    client,
    hostId,
    environmentId: environment?.environmentId ?? "",
    isTeam: environment?.ownerKind === "organization",
    botCount,
  });
  if (
    botList.status === "pending" ||
    environmentList.status === "pending" ||
    gate === "pending"
  ) {
    return { kind: "settling" };
  }
  if (gate !== "locked" || environment === null) return { kind: "clear" };
  return {
    kind: "locked",
    team: {
      environmentId: environment.environmentId,
      teamName: environment.label,
      botCount,
    },
  };
}

/** The environment the lists name for a bot, with its live bots' count. */
type BotTeam = {
  readonly environment: EnvironmentDescriptor | null;
  readonly botCount: number;
};

function botTeamOf(
  botId: string,
  bots: ReadonlyArray<BotRecord>,
  environments: ReadonlyArray<EnvironmentDescriptor>,
): BotTeam {
  const environmentId =
    bots.find((bot) => bot.botId === botId)?.environmentId ?? null;
  if (environmentId === null) return { environment: null, botCount: 0 };
  return {
    environment:
      environments.find((entry) => entry.environmentId === environmentId) ??
      null,
    botCount: environmentBotsOf(bots, environmentId).filter(
      (bot) => bot.archivedAt === null,
    ).length,
  };
}

function LockedTeamOnboarding(
  props: LockedTeam & { readonly connectable: ConnectableHosts },
): ReactNode {
  const { connectable, ...team } = props;
  const bindings = useHostEnvironmentBindings(connectable.hostIds, true);
  return (
    <BotOnboardingCard
      {...team}
      connectableHostIds={connectable.hostIds}
      environmentBindings={bindings}
    />
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

function ErrorNotice(props: {
  readonly text: string;
  readonly onRetry: () => void;
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
      <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * Slack's channel header: the bot's picture (its card on hover and click),
 * its name with the main bot's star, the ⋮ that opens the channel's settings, and the channel's views
 * under it. What the bot is for is the top of its channel; nothing else
 * sits here. Activity's label is the bot's indicator: what stopped, in red
 * and first, what runs and the tasks it tracks.
 */
function BotChannelHeader(props: {
  readonly title: string;
  readonly isMain: boolean;
  readonly settingsOpen: boolean;
  readonly onToggleSettings: () => void;
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
