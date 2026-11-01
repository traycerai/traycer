import { useId, useMemo, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { v4 as uuidv4 } from "uuid";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type {
  SandboxCatalogue,
  SandboxListResponse,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { BotAvatar } from "@/components/bots/bot-avatars";
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import { BotChannelTitle } from "@/components/bots/bot-channel-level2";
import { BotMessageComposerUnavailable } from "@/components/bots/bot-message-composer";
import { MainBotBadge } from "@/components/bots/main-bot-badge";
import { ChatBotAppPost } from "@/components/chat/chat-bot-message";
import type { TeamSetup } from "@/hooks/bots/use-team-setups";
import type { BotOnboardingArrival } from "@traycer/protocol/host/bot/onboarding-schemas";
import type { TeamSetupHistory } from "@/hooks/bots/use-team-setup-history";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import {
  SandboxCreateError,
  useSandboxCreate,
} from "@/hooks/sandboxes/use-sandbox-create-mutation";
import {
  useSandboxDefaults,
  type SandboxDefaultsRead,
} from "@/hooks/sandboxes/use-sandbox-defaults";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxTraycerModels } from "@/hooks/sandboxes/use-sandbox-traycer-models-query";
import {
  configurationStageShape,
  type StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import { createErrorNeedsFreshKey } from "@/lib/sandboxes/staged-sandbox-run";
import {
  useTeamCloudCreate,
  useTeamCloudCreateStore,
} from "@/stores/bots/team-cloud-create-store";

/**
 * A team's main bot's channel while the bot is still to be set up (Tracy Bots
 * T67): the team has no host its bots can run on, so no model runs and the
 * bot has written nothing. The app draws, in the bot's voice, what the bot is
 * and that the team needs a host, with the ways to get one
 * (`TeamHostOptionsCard`), and the message box is drawn with nothing to send
 * and why. Drawn in the Tracy surface's channel pane, beside its column.
 */
export function TeamSetupChannel(props: {
  readonly setup: TeamSetup;
  readonly client: HostClient<HostRpcRegistry> | null;
  /** The surface's host, whose bots the title's picker lists. */
  readonly hostId: string;
  /** The surface's level-2 form, which the title follows. */
  readonly level2: MobileLevel2Form | null;
}): ReactNode {
  const { setup, hostId, level2 } = props;
  // Re-read on the shared on-screen cadence while the person can see the
  // setup and it still needs a host. The team's host creating the bot rings
  // the team's room, which reaches this channel's bot list only while this
  // host listens to that room; this read is the backstop for a missed ring.
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
      <section
        aria-label={setup.title}
        data-testid="team-setup-channel"
        className="flex min-h-0 min-w-0 flex-1 flex-col md:bg-canvas"
      >
        <header className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
          <BotAvatar size="sm" />
          <BotChannelTitle
            level2={level2}
            title={setup.title}
            activeBotId={setup.botId}
            hostId={hostId}
            threadsView={null}
          />
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
              <TeamSetupPostBody
                live={{
                  environmentId: setup.environmentId,
                  teamName: setup.teamName,
                }}
              />
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
    </BotIdentityContext>
  );
}

/** The team a setup post's buttons act for. */
interface TeamSetupLive {
  readonly environmentId: string;
  readonly teamName: string;
}

/**
 * The setup post: what the team's main bot is, that the team needs a host,
 * and the ways to get one. `live` draws each way's button; the post kept as a
 * live channel's history (`null`) has none.
 */
function TeamSetupPostBody(props: {
  readonly live: TeamSetupLive | null;
}): ReactNode {
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
      <TeamHostOptionsCard live={props.live} />
    </div>
  );
}

/**
 * The ways a team gets a host its bots can run on (decision 127): cloud for
 * the team, which starts the team's kept sandbox (decision 130), or a team
 * host on a machine, which cannot run a team's bots yet, so its button is
 * drawn and does nothing, with a line saying so.
 */
function TeamHostOptionsCard(props: {
  readonly live: TeamSetupLive | null;
}): ReactNode {
  const { live } = props;
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
        description="One cloud sandbox hosts the team's bots, using the team's credit while it runs."
        action={
          live === null ? null : (
            <EnableTeamCloudAction
              environmentId={live.environmentId}
              teamName={live.teamName}
              testId="team-host-option-cloud"
            />
          )
        }
        testId="team-host-option-cloud"
      />
      <TeamHostOption
        title="Create a team host on a machine"
        description="A machine the team keeps running, signed in as the team."
        action={
          live === null ? null : (
            <TeamHostOptionUnavailable
              action="Create team host"
              testId="team-host-option-machine"
            />
          )
        }
        testId="team-host-option-machine"
      />
    </div>
  );
}

function TeamHostOption(props: {
  readonly title: string;
  readonly description: string;
  /** The option's button; `null` in the post kept as history. */
  readonly action: ReactNode;
  readonly testId: string;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={props.testId}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-ui-sm font-medium text-foreground">
          {props.title}
        </h3>
        <p className="text-ui-xs text-muted-foreground">{props.description}</p>
      </div>
      {props.action}
    </div>
  );
}

/** An option with nothing behind it yet: its button, disabled, and why. */
function TeamHostOptionUnavailable(props: {
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

/** States in which a sandbox is not, and will not become, the team's host. */
const TEAM_SANDBOX_GONE_STATES: ReadonlySet<HostSandboxState> = new Set([
  "destroying",
  "destroyed",
  "failed",
]);

/**
 * Whether `summary` is the team's kept sandbox, started or on its way: a
 * job's burst sandbox and the Automations pod host no team bot, and a failed
 * one never will.
 */
function hostsTeamBots(
  summary: SandboxSummary,
  environmentId: string,
): boolean {
  return (
    summary.environmentId === environmentId &&
    summary.kind === "agent" &&
    !summary.burst &&
    !TEAM_SANDBOX_GONE_STATES.has(summary.state)
  );
}

/**
 * Why Enable cloud cannot be pressed yet: `note` is the line under it, or
 * `null` while a read it waits on is still out.
 */
interface EnableTeamCloudBlocked {
  readonly note: string | null;
}

/**
 * What the team's create asks for: the configuration's defaults' shape over
 * the catalogue (`null` when no provider can create), or `undefined` while
 * either is unread.
 */
function teamStageShape(
  catalogue: SandboxCatalogue | undefined,
  defaults: SandboxDefaultsRead | undefined,
): StageShape | null | undefined {
  if (catalogue === undefined || defaults === undefined) return undefined;
  if (defaults.kind === "pending") return undefined;
  return configurationStageShape(
    catalogue,
    // An unreadable item reads as none set, as every create does.
    defaults.kind === "ready" ? defaults.value.defaults : null,
  );
}

/**
 * Why Enable cloud cannot be pressed for the team in `environmentId`, or
 * `null` when it can. `unlisted` is a sandbox a create from this app was
 * answered with that the list does not carry yet; `shape` is `undefined`
 * while the catalogue or the team's defaults are unread.
 */
function enableTeamCloudBlocked(input: {
  readonly environmentId: string;
  readonly models: UseQueryResult<ReadonlyArray<GuiAgentModelOption>>;
  readonly sandboxes: UseQueryResult<SandboxListResponse | null>;
  readonly unlisted: string | null;
  readonly catalogue: UseQueryResult<SandboxCatalogue>;
  readonly shape: StageShape | null | undefined;
}): EnableTeamCloudBlocked | null {
  const { models, sandboxes, catalogue, shape } = input;
  if (models.status === "error") return { note: models.error.message };
  if (models.data === undefined) return { note: null };
  if (models.data.length === 0) {
    return { note: "No model is available for team sandboxes yet." };
  }
  // An unread list is not "none": the team may have its sandbox already,
  // and a list whose refresh failed may predate it.
  if (sandboxes.status === "error") return { note: sandboxes.error.message };
  const list = sandboxes.data;
  if (list === undefined || list === null) return { note: null };
  if (
    input.unlisted !== null ||
    list.sandboxes.some((summary) =>
      hostsTeamBots(summary, input.environmentId),
    )
  ) {
    return {
      note: "The team has a cloud sandbox. Its bots start once it's running.",
    };
  }
  if (catalogue.status === "error") return { note: catalogue.error.message };
  if (shape === undefined) return { note: null };
  if (shape === null) {
    return { note: "Sandboxes aren't available right now. Try again later." };
  }
  return null;
}

/**
 * Enable cloud (decision 130): create the team's one kept sandbox in the
 * team's environment, in the configuration's default shape and region. The
 * team's main bot is created on it once it is up, which ends this setup.
 *
 * It waits for a model a team sandbox can run (a team sandbox runs only
 * Traycer's models, so without one the bot could never start), and for the
 * team to have no kept sandbox, so a second press, or a teammate's, adds
 * none. A refusal is said under the button, `insufficient_credit` included.
 */
function EnableTeamCloudAction(props: {
  readonly environmentId: string;
  readonly teamName: string;
  readonly testId: string;
}): ReactNode {
  const { environmentId, testId } = props;
  const noteId = useId();
  const models = useSandboxTraycerModels(true);
  const catalogue = useSandboxCatalogue(true);
  const defaults = useSandboxDefaults([environmentId]).get(environmentId);
  const sandboxes = useSandboxList();
  const create = useSandboxCreate("inline");
  // Held outside the card: a create outlives the card that sent it, and the
  // list's refresh answers after the create settles, so a card mounted in
  // between must still know the team's sandbox is coming.
  const pressed = useTeamCloudCreate(environmentId, sandboxes.data);
  const pending = pressed?.pending === true;

  const shape = teamStageShape(catalogue.data, defaults);
  const blocked = enableTeamCloudBlocked({
    environmentId,
    models,
    sandboxes,
    unlisted: pressed?.acceptedSandboxId ?? null,
    catalogue,
    shape,
  });

  const enable = (): void => {
    if (blocked !== null || shape === undefined || shape === null) return;
    if (pending) return;
    // An unanswered request may already have created the sandbox: its key is
    // reused until the server accepts it or refuses it before creating.
    const requestKey = pressed?.requestKey ?? uuidv4();
    const store = useTeamCloudCreateStore.getState();
    store.start(environmentId, requestKey);
    // The promise, not `mutate`'s callbacks, which are dropped when the card
    // unmounts before the answer.
    void create
      .mutateAsync({
        request: {
          os: shape.os,
          cpus: shape.cpus,
          memoryMb: shape.memoryMb,
          diskMb: shape.diskMb,
          region: shape.region,
          displayName: TEAM_SANDBOX_NAME,
          idleMinutes: shape.idleMinutes,
          burst: false,
          createdByHostId: null,
          createdByAgentId: null,
          environmentId,
          // The shape's `null` is "never"; on a create `null` is the
          // configuration's default and `0` is never.
          destroyAfterRestingMinutes: shape.destroyAfterRestingMinutes ?? 0,
          createdByTaskId: null,
          clientRequestId: requestKey,
        },
        teamName: props.teamName,
      })
      .then(
        (accepted) =>
          store.accept(environmentId, accepted.sandboxId, Date.now()),
        (error: unknown) =>
          store.fail(
            environmentId,
            !(error instanceof Error && createErrorNeedsFreshKey(error)),
          ),
      );
  };

  const note = pending ? null : (blocked?.note ?? null);
  const refusal = pending ? null : createRefusalLine(create.error);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={blocked !== null || pending}
        aria-describedby={note === null ? undefined : noteId}
        onClick={enable}
        data-testid={`${testId}-action`}
      >
        {pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Enable cloud
      </Button>
      {note === null ? null : (
        <p
          id={noteId}
          className="text-ui-xs text-muted-foreground"
          data-testid={`${testId}-note`}
        >
          {note}
        </p>
      )}
      {refusal === null ? null : (
        <p
          role="alert"
          className="text-ui-xs text-destructive"
          data-testid={`${testId}-refusal`}
        >
          {refusal}
        </p>
      )}
    </div>
  );
}

/** A failed create in words; `null` when the last create did not fail. */
function createRefusalLine(error: Error | null): string | null {
  if (error === null) return null;
  return error instanceof SandboxCreateError
    ? error.message
    : "Couldn't create the sandbox.";
}

/** The team's sandbox as the host list and Settings name it. */
const TEAM_SANDBOX_NAME = "Team bots";

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
        <TeamSetupPostBody live={null} />
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
