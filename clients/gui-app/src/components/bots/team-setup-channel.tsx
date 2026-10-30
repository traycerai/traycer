import { useId, useMemo, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { Button } from "@/components/ui/button";
import { BotAvatar } from "@/components/bots/bot-avatars";
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import { BotChannelSidebar } from "@/components/bots/bot-channel-sidebar";
import { BotMessageComposerUnavailable } from "@/components/bots/bot-message-composer";
import { BotResizablePane } from "@/components/bots/bot-resizable-pane";
import { MainBotBadge } from "@/components/bots/main-bot-badge";
import { ChatBotAppPost } from "@/components/chat/chat-bot-message";
import type { TeamSetup } from "@/hooks/bots/use-team-setups";
import type { BotOnboardingArrival } from "@traycer/protocol/host/bot/onboarding-schemas";
import type { TeamSetupHistory } from "@/hooks/bots/use-team-setup-history";

/**
 * A team's main bot's channel while the bot is still to be set up (Tracy Bots
 * T67): the team has no host its bots can run on, so no model runs and the
 * bot has written nothing. The app draws, in the bot's voice, what the bot is
 * and that the team needs a host, with the ways to get one
 * (`TeamHostOptionsCard`), and the message box is drawn with nothing to send
 * and why. Laid out as a bot's tab is, with the channel sidebar beside it.
 */
export function TeamSetupChannel(props: {
  readonly setup: TeamSetup;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
}): ReactNode {
  const { setup, hostId } = props;
  // Re-read on the shared on-screen cadence while the person can see the
  // setup and it still needs a host: the team's host creating the bot rings
  // no other host's bot list, so this is how the channel learns it went live.
  const paneVisible = usePaneVisible();
  const [settled, setSettled] = useState(false);
  const [read] = useHostQueries<HostRpcRegistry, "bot.onboarding.read">({
    client: props.client,
    requests: [
      {
        method: "bot.onboarding.read",
        params: { environmentId: setup.environmentId },
      },
    ],
    cacheKeyIdentity: undefined,
    options: { poll: paneVisible && !settled },
  });
  if (
    !settled &&
    read.data !== undefined &&
    read.data.setup?.state !== "needs_host"
  ) {
    setSettled(true);
  }
  const identity = useMemo(
    (): BotIdentity => ({
      botId: setup.botId,
      title: setup.title,
      owner: null,
    }),
    [setup.botId, setup.title],
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
          <BotChannelSidebar activeBotId={setup.botId} hostId={hostId} />
        </BotResizablePane>
        <section
          aria-label={setup.title}
          data-testid="team-setup-channel"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <header className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
            <BotAvatar size="sm" />
            <h1
              className="min-w-0 truncate text-ui-md font-bold text-foreground"
              data-testid="bot-tab-title"
            >
              {setup.title}
            </h1>
            <MainBotBadge testId="bot-tab-main" tone="muted" />
          </header>
          {/* The post sits at the bottom, as a channel's newest row does; its
              top margin, not the column's end alignment, puts it there, so a
              post taller than the pane overflows downward and scrolls from
              its top. */}
          <div
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-3"
            data-testid="team-setup-scroller"
          >
            <div className="mt-auto min-w-0" data-testid="team-setup-post-slot">
              <ChatBotAppPost name={setup.title} testId="team-setup-post">
                <TeamSetupPostBody actions />
              </ChatBotAppPost>
            </div>
          </div>
          <BotMessageComposerUnavailable
            placeholder={`Message ${setup.title}`}
            label={`Message ${setup.title}`}
            reason={`${setup.title} can reply once the team has a host.`}
            testId="team-setup-composer"
          />
        </section>
      </div>
    </BotIdentityContext>
  );
}

/**
 * The setup post: what the team's main bot is, that the team needs a host,
 * and the ways to get one. `actions` draws each way's button; the post kept
 * as a live channel's history has none.
 */
function TeamSetupPostBody(props: { readonly actions: boolean }): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-ui-sm text-foreground">
      <p>
        I'm this team's main bot. Tell me here what the team wants done and I'll
        set up bots for each area: a channel per bot, with the work and its
        reports in it.
      </p>
      <p>
        Before I can run, the team needs a host: a machine where its bots
        execute.
      </p>
      <TeamHostOptionsCard actions={props.actions} />
    </div>
  );
}

/**
 * The ways a team gets a host its bots can run on (decision 127): cloud for
 * the team, or a team host on a machine. Neither can run a team's bots yet,
 * so with `actions` each option's button is drawn and does nothing, with a
 * line saying so.
 */
function TeamHostOptionsCard(props: { readonly actions: boolean }): ReactNode {
  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border/60 bg-card p-3"
      data-testid="team-host-options"
    >
      <h2 className="text-ui-sm font-semibold text-foreground">
        Give the team a host
      </h2>
      <TeamHostOption
        title="Enable cloud for the team"
        description="Bots run on sandboxes started for each job."
        action="Enable cloud"
        actions={props.actions}
        testId="team-host-option-cloud"
      />
      <TeamHostOption
        title="Create a team host on a machine"
        description="A machine the team keeps running, signed in as the team."
        action="Create team host"
        actions={props.actions}
        testId="team-host-option-machine"
      />
    </div>
  );
}

function TeamHostOption(props: {
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly actions: boolean;
  readonly testId: string;
}): ReactNode {
  const { testId } = props;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-ui-sm font-medium text-foreground">
          {props.title}
        </h3>
        <p className="text-ui-xs text-muted-foreground">{props.description}</p>
      </div>
      {props.actions ? (
        <TeamHostOptionAction action={props.action} testId={testId} />
      ) : null}
    </div>
  );
}

function TeamHostOptionAction(props: {
  readonly action: string;
  readonly testId: string;
}): ReactNode {
  const { testId } = props;
  const noteId = useId();
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled
        aria-describedby={noteId}
        data-testid={`${testId}-action`}
      >
        {props.action}
      </Button>
      <p
        id={noteId}
        className="text-ui-xs text-muted-foreground"
        data-testid={`${testId}-unavailable`}
      >
        Not available yet.
      </p>
    </div>
  );
}

/**
 * The top of a live team main bot's channel (T67b): the post the channel
 * showed before the team had a host, kept whole as history with its buttons
 * retired, and a line saying how the host came. The bot's own posts follow
 * it.
 */
export function TeamSetupHistoryRows(props: {
  readonly botTitle: string;
  readonly teamName: string;
  readonly history: TeamSetupHistory;
}): ReactNode {
  return (
    <div
      className="flex min-w-0 flex-col gap-2 px-2 pt-3"
      data-testid="team-setup-history"
    >
      <ChatBotAppPost name={props.botTitle} testId="team-setup-history-post">
        <TeamSetupPostBody actions={false} />
      </ChatBotAppPost>
      <p
        className="px-3 text-center text-ui-xs text-muted-foreground"
        data-testid="team-setup-arrival"
      >
        {TEAM_SETUP_ARRIVAL_LINES[props.history.arrival.kind](props.teamName)}
      </p>
    </div>
  );
}

/** How the team's host came, as the channel's system line says it. */
const TEAM_SETUP_ARRIVAL_LINES: Readonly<
  Record<BotOnboardingArrival["kind"], (teamName: string) => string>
> = {
  cloud: (teamName) => `Cloud enabled for ${teamName} · bots run on sandboxes`,
};
