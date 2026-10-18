import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { BotsUnavailableNotice } from "@/components/bots/bots-unavailable-notice";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import {
  useBotSubscriptionForHost,
  type BotSubscriptionSnapshot,
} from "@/hooks/bots/use-bot-subscription";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useBotClaimAuthorityMutation } from "@/hooks/bots/use-bot-mutations";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { BotConversationView } from "@/components/bots/bot-conversation-view";
import { BotUnderTheHoodPanel } from "@/components/bots/bot-under-the-hood-panel";
import { BotSettingsPanel } from "@/components/bots/bot-settings-panel";
import { cn } from "@/lib/utils";

type BotTabView = "conversation" | "under-the-hood" | "settings";

function isBotTabView(value: string): value is BotTabView {
  return (
    value === "conversation" ||
    value === "under-the-hood" ||
    value === "settings"
  );
}

/**
 * A bot's tab (Tracy Bots). Bound to ONE host for life through
 * `TabHostProvider`: the host the bot's trunk runs on when that host can be
 * dialled, else the host the window reads (the offline state). Everything
 * below reads that host - the stream, the conversation list, every write.
 *
 * Three relations between the tab's host and the bot's bound host:
 * - bound here: the full tab;
 * - bound elsewhere and that host is reachable: view it THROUGH that host
 *   (the tab record is rebound and this surface remounts) or move it here
 *   with `bot.claimAuthority`; never a clone;
 * - bound elsewhere and that host is offline: the transcript is a
 *   placeholder naming the host, the conversation list and a queued send
 *   go through this tab's host, and "Move it here" is offered.
 */
export function BotTabSurface(props: {
  readonly botId: string;
  readonly hostId: string;
}): ReactNode {
  const { botId, hostId } = props;
  // A tab is created only from Home's bots band, which draws nothing until
  // the host advertises `bot.list`; a RESTORED tab (the store persists per
  // window) meets whatever that host advertises now. The `bot.*` namespace
  // ships as one block, so this one presence check stands for every write
  // the tab offers; without it the tab shows the update notice and no
  // control that would call a method the host lacks.
  const support = useHostMethodSupport(hostId, "bot.list");
  const directory = useHostDirectoryList();
  if (support === null) return null;
  if (!support) {
    const hostLabel =
      directory.data?.find((entry) => entry.hostId === hostId)?.label ?? hostId;
    return (
      <div
        className="flex h-full flex-col justify-center"
        data-testid="bot-tab"
      >
        <BotsUnavailableNotice
          hostLabel={hostLabel}
          testId="bot-tab-unavailable"
        />
      </div>
    );
  }
  return (
    <TabHostProvider key={hostId} hostId={hostId}>
      <BotTabBody botId={botId} hostId={hostId} />
    </TabHostProvider>
  );
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
  const [view, setView] = useState<BotTabView>("conversation");

  // A deleted bot has no tab: the store removal closes it everywhere. Two
  // signals say so - the stream's `deleted` frame, and a `bot.list` answer
  // (refetched on focus) that no longer carries the bot, which is how a
  // delete made while this stream was down reaches the tab.
  const botList = useBotListQuery(client, true);
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
  // the tab asks again when it comes back into view: the window becoming
  // visible, and this tab becoming the active one (inactive tabs stay
  // mounted, hidden).
  const { resubscribe } = subscription;
  const paneVisible = usePaneVisible();
  const wasVisibleRef = useRef(paneVisible);
  useEffect(() => {
    const becameVisible = paneVisible && !wasVisibleRef.current;
    wasVisibleRef.current = paneVisible;
    if (becameVisible) resubscribe();
  }, [paneVisible, resubscribe]);
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") resubscribe();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [resubscribe]);

  const snapshot = subscription.snapshot;
  if (snapshot === null) {
    if (subscription.error !== null) {
      return (
        <StreamErrorNotice
          message={subscription.error}
          onRetry={resubscribe}
          className="m-4"
        />
      );
    }
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
  readonly streamError: string | null;
  readonly onRetry: () => void;
  readonly view: BotTabView;
  readonly onViewChange: (view: BotTabView) => void;
}): ReactNode {
  const { botId, hostId, snapshot, streamError, onRetry, view, onViewChange } =
    props;
  const connectable = useConnectableHostIds();
  const directory = useHostDirectoryList();
  const boundHere = snapshot.boundHost.isThisHost;
  const boundHostId = snapshot.boundHost.hostId;
  const boundHostLabel = useMemo(
    () =>
      boundHostId === null
        ? "No host"
        : (directory.data?.find((entry) => entry.hostId === boundHostId)
            ?.label ?? boundHostId),
    [boundHostId, directory.data],
  );
  // Offline means: not this host, and not dialable right now. Until the
  // directory has answered the host counts as reachable, so a tab does not
  // flash the offline state on every open.
  // A bot no host runs (`boundHostId` null) is offline outright.
  const boundOffline =
    !boundHere &&
    (boundHostId === null ||
      (connectable.resolved && !connectable.hostIds.includes(boundHostId)));
  const offlineHostLabel = boundOffline ? boundHostLabel : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bot-tab">
      <BotTabHeader hostId={hostId} snapshot={snapshot} />
      {streamError === null ? null : (
        // A fatal close AFTER a snapshot: the last reading stays on screen,
        // marked as such, and the retry sits on top of it.
        <StreamErrorNotice
          message={streamError}
          onRetry={onRetry}
          className="mx-4 mb-2"
        />
      )}
      {boundHere ? null : (
        <BoundElsewhereBanner
          botId={botId}
          boundHostId={boundHostId}
          boundHostLabel={boundHostLabel}
          offline={boundOffline}
          onMoved={onRetry}
        />
      )}
      <Tabs
        value={view}
        onValueChange={(next) => {
          if (isBotTabView(next)) onViewChange(next);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList aria-label="Bot view" className="mx-4 self-start">
          <TabsTrigger
            value="conversation"
            data-testid="bot-tab-view-conversation"
          >
            Conversation
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
        <TabsContent
          value="conversation"
          className="flex min-h-0 flex-1 flex-col"
        >
          <BotConversationView
            botId={botId}
            hostId={hostId}
            botTitle={snapshot.bot.title}
            offlineHostLabel={offlineHostLabel}
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
            offlineHostLabel={offlineHostLabel}
          />
        </TabsContent>
        <TabsContent value="settings" className="flex min-h-0 flex-1 flex-col">
          <BotSettingsPanel bot={snapshot.bot} canEdit={boundHere} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StreamErrorNotice(props: {
  readonly message: string;
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
      <span>Couldn&apos;t reach this bot: {props.message}</span>
      <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}

function BotTabHeader(props: {
  readonly hostId: string;
  readonly snapshot: BotSubscriptionSnapshot;
}): ReactNode {
  const { hostId, snapshot } = props;
  const client = useTabHostClient();
  const environments = useEnvironmentListQuery(client, true);
  const directory = useHostDirectoryList();
  const environmentLabel = useMemo(() => {
    const match = environments.data?.environments.find(
      (environment) => environment.environmentId === snapshot.bot.environmentId,
    );
    return match?.label ?? snapshot.bot.environmentId;
  }, [environments.data, snapshot.bot.environmentId]);
  const hostLabel = useMemo(
    () =>
      directory.data?.find((entry) => entry.hostId === hostId)?.label ?? hostId,
    [directory.data, hostId],
  );
  const openRequests = snapshot.openRequestCount;
  return (
    <header className="flex flex-wrap items-center gap-3 px-4 pt-4 pb-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/6 text-muted-foreground">
        <Bot className="size-4.5" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <h1
          className="truncate text-ui-md font-semibold text-foreground"
          data-testid="bot-tab-title"
        >
          {snapshot.bot.title}
        </h1>
        <p className="truncate text-ui-xs text-muted-foreground">
          {environmentLabel} · {hostLabel}
        </p>
      </div>
      {openRequests !== null && openRequests > 0 ? (
        <Badge variant="warning" size="sm" data-testid="bot-tab-open-requests">
          {openRequests === 1
            ? "1 open request"
            : `${openRequests} open requests`}
        </Badge>
      ) : null}
    </header>
  );
}

function boundElsewhereText(
  boundHostId: string | null,
  boundHostLabel: string,
  offline: boolean,
): string {
  if (boundHostId === null) {
    return "No host runs this bot. Move it here to message it.";
  }
  if (offline) {
    return `This bot runs on ${boundHostLabel}, which is offline. A message you send now is saved and delivered when it is back.`;
  }
  return `This bot runs on ${boundHostLabel}. Its conversation is read there.`;
}

/**
 * The bot's trunk runs on another host. Reachable: view it through that host
 * (the tab rebinds and remounts there), or move it here, which makes THIS
 * host the bound one and re-reads the stream. Offline: say so, say what a
 * send does meanwhile, and offer the move alone - there is nothing to view
 * through until the host is back. No host (`boundHostId` null): nothing
 * queues a send, so the move is the only way to message it.
 */
function BoundElsewhereBanner(props: {
  readonly botId: string;
  readonly boundHostId: string | null;
  readonly boundHostLabel: string;
  readonly offline: boolean;
  readonly onMoved: () => void;
}): ReactNode {
  const { botId, boundHostId, boundHostLabel, offline, onMoved } = props;
  const client = useTabHostClient();
  const claim = useBotClaimAuthorityMutation(client);
  const rebindBotTab = useBotTabsStore((s) => s.rebindBotTab);
  return (
    <div
      role="status"
      data-testid="bot-tab-bound-elsewhere"
      data-offline={offline ? "true" : "false"}
      className="mx-4 mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-info/30 bg-info/10 px-4 py-3 text-ui-sm text-info-foreground"
    >
      <span>{boundElsewhereText(boundHostId, boundHostLabel, offline)}</span>
      <span className="flex items-center gap-2">
        {offline || boundHostId === null ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={claim.isPending}
            onClick={() => rebindBotTab(botId, boundHostId)}
          >
            View on {boundHostLabel}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={claim.isPending}
          data-testid="bot-tab-move-here"
          onClick={() =>
            claim.mutate({ botId }, { onSuccess: () => onMoved() })
          }
        >
          Move it here
          {claim.isPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      </span>
    </div>
  );
}
