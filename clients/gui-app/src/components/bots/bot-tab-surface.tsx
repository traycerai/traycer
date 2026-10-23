import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Hash } from "lucide-react";
import type { BotOpenResponse } from "@traycer/protocol/host/bot/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
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
import { useBotListChangedSubscriptionForHost } from "@/hooks/bots/use-bot-list-changed-subscription";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentMembers } from "@/hooks/bots/use-environment-members-query";
import { useBotOpenMutation } from "@/hooks/bots/use-bot-mutations";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { BotChannelView } from "@/components/bots/bot-channel-view";
import { BotChannelSidebar } from "@/components/bots/bot-channel-sidebar";
import { BotUnderTheHoodPanel } from "@/components/bots/bot-under-the-hood-panel";
import { BotSettingsPanel } from "@/components/bots/bot-settings-panel";
import {
  botPausedCopy,
  botTabMoveTarget,
  botTabOpenState,
  type BotTabPausedReason,
} from "@/components/bots/bot-tab-open-state";
import { cn } from "@/lib/utils";

type BotTabView = "messages" | "under-the-hood" | "settings";

function isBotTabView(value: string): value is BotTabView {
  return (
    value === "messages" || value === "under-the-hood" || value === "settings"
  );
}

/**
 * A bot's tab (Tracy Bots). The person never picks the machine a bot runs
 * on: the tab opens through the host it was created on (this host, from
 * Home), asks it `bot.open`, and follows the answer -
 * - another host serves the bot and this client can reach it: the tab is
 *   rebound there silently, and this surface remounts on it;
 * - this host serves it (bound here, or claimed here because its host was
 *   away): the full tab;
 * - nobody can serve it from here: the paused state, which names no machine;
 *   the channel list and a queued post keep working through this host.
 *
 * Laid out as Slack is (decision 41): the person's environments and their
 * bots as channels down the side, and the bot's channel beside them, with
 * its under-the-hood view and its settings as the channel's tabs.
 *
 * Bound to ONE host at a time through `TabHostProvider`; everything below
 * reads that host - the stream, the conversation list, every write. A tab
 * left on a host this client can no longer dial is moved back to the app's
 * host by the next open from Home (`HomeBotRow`), which may read that host;
 * the tab itself never reads the app-wide host.
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
  if (support === null) return null;
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
  const rebindBotTab = useBotTabsStore((s) => s.rebindBotTab);
  const [view, setView] = useState<BotTabView>("messages");

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
    tabHostId: hostId,
    connectable,
  });
  const moveToHostId = botTabMoveTarget({
    response: answer,
    tabHostId: hostId,
    connectable,
  });
  useEffect(() => {
    if (moveToHostId !== null) rebindBotTab(botId, moveToHostId);
  }, [botId, moveToHostId, rebindBotTab]);

  // A deleted bot has no tab: the store removal closes it everywhere. Two
  // signals say so - the stream's `deleted` frame, and a `bot.list` answer
  // that no longer carries the bot, which is how a delete made while this
  // stream was down reaches the tab, and how a `bot.open` that found no bot
  // does (every open invalidates the list).
  const botList = useBotListQuery(client, true);
  // A teammate's rename, claim or delete reaches the list (and so this tab)
  // without waiting for focus, through the tab's own host.
  useBotListChangedSubscriptionForHost(hostId, true);
  const listedBots = botList.data?.bots;
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
  } = props;
  const client = useTabHostClient();
  const environments = useEnvironmentListQuery(client, true);
  const environmentLabel = useMemo(() => {
    const match = environments.data?.environments.find(
      (environment) => environment.environmentId === snapshot.bot.environmentId,
    );
    return match?.label ?? snapshot.bot.environmentId;
  }, [environments.data, snapshot.bot.environmentId]);
  const botList = useBotListQuery(client, true);
  const environmentBotIds = useMemo(
    () =>
      environmentBotIdsOf(
        botList.data?.bots ?? NO_BOTS,
        snapshot.bot.environmentId,
      ),
    [botList.data, snapshot.bot.environmentId],
  );
  const paused = pausedReason !== null;
  // Who wrote each channel row. A host without the method shows the other
  // members by id.
  const membersSupported =
    useHostMethodSupport(hostId, "environment.members") === true;
  const resolveMember = useEnvironmentMembers(
    client,
    snapshot.bot.environmentId,
    membersSupported,
  );
  // Held here, above the views, so the open thread and the session shown
  // under the hood survive a switch between the channel's tabs.
  const [openThreadPostId, setOpenThreadPostId] = useState<string | null>(null);
  const [sessionChatId, setSessionChatId] = useState<string | null>(null);
  const openUnderTheHood = useCallback(
    (threadSessionChatId: string) => {
      setSessionChatId(threadSessionChatId);
      onViewChange("under-the-hood");
    },
    [onViewChange],
  );

  return (
    <div className="@container flex h-full min-h-0" data-testid="bot-tab">
      <aside className="hidden min-h-0 w-1/5 max-w-64 shrink-0 flex-col border-r border-border/60 @3xl:flex">
        <BotChannelSidebar activeBotId={botId} hostId={hostId} />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Tabs
          value={view}
          onValueChange={(next) => {
            if (isBotTabView(next)) onViewChange(next);
          }}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <BotChannelHeader
            snapshot={snapshot}
            environmentLabel={environmentLabel}
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
              botTitle={snapshot.bot.title}
              paused={paused}
              resolveMember={resolveMember}
              openThreadPostId={openThreadPostId}
              onOpenThread={setOpenThreadPostId}
              onOpenUnderTheHood={openUnderTheHood}
            />
          </TabsContent>
          <TabsContent
            value="under-the-hood"
            className="flex min-h-0 flex-1 flex-col"
          >
            <BotUnderTheHoodPanel
              botId={botId}
              hostId={hostId}
              botTitle={snapshot.bot.title}
              trunkChatId={snapshot.bot.trunkChatId}
              tasks={snapshot.tasks}
              openRequestCount={snapshot.openRequestCount}
              paused={paused}
              environmentLabel={environmentLabel}
              environmentBotIds={environmentBotIds}
              sessionChatId={sessionChatId}
              onSelectSession={setSessionChatId}
            />
          </TabsContent>
          <TabsContent
            value="settings"
            className="flex min-h-0 flex-1 flex-col"
          >
            <BotSettingsPanel bot={snapshot.bot} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

const NO_BOTS: ReadonlyArray<BotRecord> = [];

/** The bots of one environment, by id, as the list names them. */
function environmentBotIdsOf(
  bots: ReadonlyArray<BotRecord>,
  environmentId: string,
): ReadonlyArray<string> {
  return bots
    .filter((bot) => bot.environmentId === environmentId)
    .map((bot) => bot.botId);
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
 * Slack's channel header: `# name`, the environment it belongs to, the
 * open-request hint, and the channel's tabs under it.
 */
function BotChannelHeader(props: {
  readonly snapshot: BotSubscriptionSnapshot;
  readonly environmentLabel: string;
}): ReactNode {
  const { snapshot, environmentLabel } = props;
  const openRequests = snapshot.openRequestCount;
  return (
    <header className="flex shrink-0 flex-col gap-1 px-4 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1
          className="flex min-w-0 items-center gap-1 text-ui-md font-bold text-foreground"
          data-testid="bot-tab-title"
        >
          <Hash className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{snapshot.bot.title}</span>
        </h1>
        <span className="truncate text-ui-xs text-muted-foreground">
          {environmentLabel}
        </span>
        {openRequests !== null && openRequests > 0 ? (
          <Badge
            variant="warning"
            size="sm"
            data-testid="bot-tab-open-requests"
          >
            {openRequests === 1
              ? "1 open request"
              : `${openRequests} open requests`}
          </Badge>
        ) : null}
      </div>
      <TabsList variant="line" aria-label="Channel view">
        <TabsTrigger value="messages" data-testid="bot-tab-view-messages">
          Messages
        </TabsTrigger>
        <TabsTrigger
          value="under-the-hood"
          data-testid="bot-tab-view-under-the-hood"
        >
          Under the hood
        </TabsTrigger>
        <TabsTrigger value="settings" data-testid="bot-tab-view-settings">
          Settings
        </TabsTrigger>
      </TabsList>
    </header>
  );
}

/**
 * The paused state: why the bot cannot be served to this tab now, with no
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
