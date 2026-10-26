import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import type {
  BotOnboardingArea,
  BotOnboardingGithub,
  BotOnboardingReadResponse,
} from "@traycer/protocol/host/bot/onboarding-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DashboardLinkButton } from "@/components/settings/host-scope/dashboard-link-button";
import { CreateBotNoHost } from "@/components/home/bots/create-bot-form";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import {
  useTeamOnboardingFlow,
  type TeamOnboardingFlow,
} from "@/components/home/bots/use-team-onboarding-flow";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTeamOnboardingGate } from "@/hooks/bots/use-team-onboarding-gate";
import type { HostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import { teamGithubDashboardUrl } from "@/lib/sandboxes/secrets-dashboard";
import { cn } from "@/lib/utils";

/**
 * A team environment's onboarding (Tracy Bots T48), at the top of its
 * section in the channel sidebar until the team's bots exist. Its copy is the
 * interaction model's Onboarding section.
 *
 * 1. GitHub: the team's set, each repository the installing admin can only
 *    read marked so. Until the set holds a repository, an admin is offered
 *    the dashboard's GitHub page, where linking and installing happen, and
 *    anyone else reads "Waiting for an admin". Each pending case is shown
 *    where it occurs - here, or on that page - rather than kept.
 * 2. Bots: the host's catalog as checkboxes, the ones ticked by default
 *    first. Any member may tick, before GitHub is connected too; each change
 *    is kept as the team's choice.
 * 3. Channels: once the set holds a repository, "Open your channels" creates
 *    the chosen bots on the host they will run on and opens the first one's
 *    channel, where it has announced itself. A bot an earlier try made on
 *    another host is that host's to finish (`choice.pending`): the next
 *    "Open your channels" goes to that host when this client reaches it, and
 *    the area reads "Still being set up" until it is done.
 *
 * After onboarding the card leaves, except to tell an admin the set needs a
 * new installing admin, with the page where one takes over.
 *
 * Read and chosen through the tab's host: both are the cloud's, so any host
 * answers the same. The create goes to the host the app picks for the
 * environment's bots (`chooseBotCreateHost`), as "Add a bot" does.
 */
export function BotOnboardingCard(props: {
  readonly environmentId: string;
  /** The team's handle, which names its dashboard pages. */
  readonly teamName: string;
  /** The team's bots as its list shows them now (`teamOnboardingGate`). */
  readonly botCount: number;
  readonly connectableHostIds: ReadonlyArray<string>;
  readonly environmentBindings: HostEnvironmentBindings;
}): ReactNode {
  const client = useTabHostClient();
  const tabHostId = useTabHostId();
  const { gate, onboarding } = useTeamOnboardingGate({
    client,
    hostId: tabHostId,
    environmentId: props.environmentId,
    isTeam: true,
    botCount: props.botCount,
  });
  const data = onboarding.data;
  if (data === undefined) return null;
  if (data.choice !== null && data.choice.completedAt !== null) {
    return (
      <NeedsInstallingAdmin github={data.github} teamName={props.teamName} />
    );
  }
  // A team that pre-dates onboarding is never asked to onboard.
  if (gate === "none") return null;
  return <OnboardingSteps {...props} data={data} />;
}

/** The set lost its installing admin after onboarding: an admin's to fix. */
function NeedsInstallingAdmin(props: {
  readonly github: BotOnboardingGithub;
  readonly teamName: string;
}): ReactNode {
  const { github, teamName } = props;
  if (github.state !== "needs_installing_admin" || !github.callerCanConnect) {
    return null;
  }
  return (
    <div
      role="status"
      data-testid="bot-onboarding-needs-installing-admin"
      className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-ui-xs text-warning-foreground"
    >
      <span>Needs installing admin</span>
      <DashboardLinkButton
        page={(signInUrl) => teamGithubDashboardUrl(signInUrl, teamName)}
        label="Open the dashboard"
        testId="bot-onboarding-needs-installing-admin-link"
      />
    </div>
  );
}

function OnboardingSteps(props: {
  readonly environmentId: string;
  readonly teamName: string;
  readonly connectableHostIds: ReadonlyArray<string>;
  readonly environmentBindings: HostEnvironmentBindings;
  readonly data: BotOnboardingReadResponse;
}): ReactNode {
  const { teamName, environmentBindings, data } = props;
  const flow = useTeamOnboardingFlow({
    environmentId: props.environmentId,
    connectableHostIds: props.connectableHostIds,
    environmentBindings,
    data,
    onOpened: NOTHING,
  });
  return (
    <div
      data-testid="bot-onboarding-card"
      className="flex flex-col gap-3 rounded-md border border-border/60 bg-foreground/3 p-3"
    >
      <StepTrail unlocked={data.unlocked} />
      <GithubStep github={data.github} teamName={teamName} />
      <BotsStep
        catalog={data.catalog}
        chosen={flow.chosen}
        pendingAreas={flow.pendingAreas}
        disabled={flow.completing}
        onToggle={flow.toggle}
      />
      <OnboardingCreateControls
        flow={flow}
        unlocked={data.unlocked}
        teamName={teamName}
        environmentBindings={environmentBindings}
      />
      <div className="flex justify-end">
        <OnboardingOpenButton flow={flow} label="Open your channels" />
      </div>
    </div>
  );
}

const NOTHING = (): void => undefined;

/**
 * What the create needs once GitHub is connected: the notice when no host can
 * make the bots, and the model they run on.
 */
export function OnboardingCreateControls(props: {
  readonly flow: TeamOnboardingFlow;
  readonly unlocked: boolean;
  readonly teamName: string;
  readonly environmentBindings: HostEnvironmentBindings;
}): ReactNode {
  const { flow, unlocked, teamName, environmentBindings } = props;
  if (!unlocked) return null;
  return (
    <>
      {flow.nothingPending && flow.hostChoice.kind !== "chosen" ? (
        <CreateBotNoHost
          checking={flow.hostChoice.kind === "checking"}
          environmentLabel={teamName}
          someUnchecked={environmentBindings.failedHostIds.length > 0}
          onRetry={environmentBindings.retryFailed}
        />
      ) : null}
      <div className="flex min-w-0">
        <HarnessModelPicker
          labelDisplay="responsive"
          maxModeContext={flow.maxModeContext}
          store={flow.toolbarStore}
          withServiceTier={false}
          withReasoning
          tuiOnly={false}
          lockedHarnessId={null}
          disabled={flow.busy || flow.hostId === null}
          registerActivation={false}
          createProfileHostId={flow.hostId}
          runTargetHostId={flow.hostId}
          terminalLoginSurface={null}
          profileAdmission={null}
          embedding={null}
        />
      </div>
    </>
  );
}

/** The onboarding's primary action, which creates the chosen bots. */
export function OnboardingOpenButton(props: {
  readonly flow: TeamOnboardingFlow;
  readonly label: string;
}): ReactNode {
  const { flow } = props;
  return (
    <Button
      type="button"
      size="sm"
      disabled={!flow.canOpen}
      data-testid="bot-onboarding-open"
      onClick={flow.openChannels}
    >
      {flow.completing ? (
        <AgentSpinningDots
          className="ml-1"
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      {props.label}
    </Button>
  );
}

function StepTrail(props: { readonly unlocked: boolean }): ReactNode {
  const { unlocked } = props;
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-ui-xs text-muted-foreground">
      <li className={cn(!unlocked && "font-medium text-foreground")}>
        1 GitHub{unlocked ? " ✓" : null}
      </li>
      <li aria-hidden="true">›</li>
      <li className={cn(unlocked && "font-medium text-foreground")}>2 Bots</li>
      <li aria-hidden="true">›</li>
      <li>3 Channels</li>
    </ol>
  );
}

export function BotsStep(props: {
  readonly catalog: ReadonlyArray<BotOnboardingArea>;
  readonly chosen: ReadonlyArray<string>;
  readonly pendingAreas: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onToggle: (area: string, checked: boolean) => void;
}): ReactNode {
  const { catalog, chosen, pendingAreas, disabled, onToggle } = props;
  const ticked = catalog.filter((entry) => entry.tickedByDefault);
  const more = catalog.filter((entry) => !entry.tickedByDefault);
  return (
    <>
      <div className="flex flex-col gap-1">
        <h3 className="text-ui-sm font-medium text-foreground">
          Choose the bots your team starts with
        </h3>
        <p className="text-ui-xs text-muted-foreground">
          Each one gets its own channel. You can add or remove bots later.
        </p>
      </div>
      <AreaList
        areas={ticked}
        chosen={chosen}
        pendingAreas={pendingAreas}
        disabled={disabled}
        onToggle={onToggle}
      />
      {more.length === 0 ? null : (
        <>
          <p className="text-ui-xs font-medium text-foreground">More bots</p>
          <AreaList
            areas={more}
            chosen={chosen}
            pendingAreas={pendingAreas}
            disabled={disabled}
            onToggle={onToggle}
          />
        </>
      )}
    </>
  );
}

export function GithubStep(props: {
  readonly github: BotOnboardingGithub;
  readonly teamName: string;
}): ReactNode {
  const { github, teamName } = props;
  if (github.repositories.length > 0 && github.state === "ok") {
    return (
      <div
        data-testid="bot-onboarding-github-connected"
        className="flex flex-col gap-1 rounded-md border border-success/30 bg-success/10 p-2 text-ui-xs text-success-foreground"
      >
        <span className="flex items-center gap-1">
          <Check className="size-3.5 shrink-0" aria-hidden="true" />
          GitHub connected
        </span>
        <ul className="flex flex-col gap-0.5">
          {github.repositories.map((repository) => (
            <li
              key={repository.repositoryId}
              className="flex min-w-0 items-center gap-1.5"
            >
              <span className="truncate">
                {repository.fullName ?? repository.repositoryId}
              </span>
              {repository.permission === "read" ? (
                <Badge
                  variant="secondary"
                  data-testid="bot-onboarding-read-only"
                >
                  Read-only
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (github.state === "needs_installing_admin") {
    return (
      <div
        role="status"
        data-testid="bot-onboarding-github-needs-installing-admin"
        className="flex flex-col gap-2 text-ui-xs text-muted-foreground"
      >
        <span>Needs installing admin</span>
        {github.callerCanConnect ? (
          <DashboardLinkButton
            page={(signInUrl) => teamGithubDashboardUrl(signInUrl, teamName)}
            label="Open the dashboard"
            testId="bot-onboarding-github-dashboard"
          />
        ) : null}
      </div>
    );
  }
  if (github.callerCanConnect) {
    return (
      <div className="flex">
        <DashboardLinkButton
          page={(signInUrl) => teamGithubDashboardUrl(signInUrl, teamName)}
          label="Connect GitHub"
          testId="bot-onboarding-connect-github"
        />
      </div>
    );
  }
  return (
    <p
      role="status"
      data-testid="bot-onboarding-waiting-for-admin"
      className="text-ui-xs text-muted-foreground"
    >
      Waiting for an admin
    </p>
  );
}

function AreaList(props: {
  readonly areas: ReadonlyArray<BotOnboardingArea>;
  readonly chosen: ReadonlyArray<string>;
  readonly pendingAreas: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onToggle: (area: string, checked: boolean) => void;
}): ReactNode {
  return (
    <ul className="flex flex-col gap-1.5">
      {props.areas.map((entry) => (
        <li key={entry.area}>
          <AreaRow
            entry={entry}
            checked={props.chosen.includes(entry.area)}
            pending={props.pendingAreas.includes(entry.area)}
            disabled={props.disabled}
            onToggle={props.onToggle}
          />
        </li>
      ))}
    </ul>
  );
}

function AreaRow(props: {
  readonly entry: BotOnboardingArea;
  readonly checked: boolean;
  /** Its bot exists on a host that has not finished setting it up. */
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onToggle: (area: string, checked: boolean) => void;
}): ReactNode {
  const { entry, checked, pending, disabled, onToggle } = props;
  const id = useId();
  return (
    <label
      htmlFor={id}
      data-testid="bot-onboarding-area"
      data-area={entry.area}
      className="flex items-start gap-2 rounded-md border border-border/60 p-2 text-ui-xs"
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onToggle(entry.area, value === true)}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="font-medium text-foreground">{entry.title}</span>
          {pending ? (
            <Badge variant="secondary" data-testid="bot-onboarding-pending">
              Still being set up
            </Badge>
          ) : null}
        </span>
        <span className="text-muted-foreground">{entry.description}</span>
        {entry.when === null ? null : (
          <span className="text-muted-foreground">{entry.when}</span>
        )}
      </span>
    </label>
  );
}
