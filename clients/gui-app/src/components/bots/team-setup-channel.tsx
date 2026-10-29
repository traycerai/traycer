import { useMemo, type ReactNode } from "react";
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
  readonly hostId: string;
}): ReactNode {
  const { setup, hostId } = props;
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
          <div className="flex min-h-0 flex-1 flex-col justify-end overflow-y-auto px-2 py-3">
            <ChatBotAppPost name={setup.title} testId="team-setup-post">
              <div className="flex min-w-0 flex-col gap-2 text-ui-sm text-foreground">
                <p>
                  I'm this team's main bot. Tell me here what the team wants
                  done and I'll set up bots for each area: a channel per bot,
                  with the work and its reports in it.
                </p>
                <p>
                  Before I can run, the team needs a host: a machine where its
                  bots execute.
                </p>
                <TeamHostOptionsCard />
              </div>
            </ChatBotAppPost>
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
 * The ways a team gets a host its bots can run on (decision 127): cloud for
 * the team, or a team host on a machine. What each one does from here is not
 * settled yet, so each is its heading and what it is, with no action.
 */
function TeamHostOptionsCard(): ReactNode {
  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border/60 bg-card p-3"
      data-testid="team-host-options"
    >
      <h2 className="text-ui-sm font-semibold text-foreground">
        Give the team a host
      </h2>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-ui-sm font-medium text-foreground">
          Enable cloud for the team
        </h3>
        <p className="text-ui-xs text-muted-foreground">
          Bots run on sandboxes started for each job.
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-ui-sm font-medium text-foreground">
          Create a team host on a machine
        </h3>
        <p className="text-ui-xs text-muted-foreground">
          A machine the team keeps running, signed in as the team.
        </p>
      </div>
    </div>
  );
}
