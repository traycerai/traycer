import { useId, useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "zustand";
import { Check } from "lucide-react";
import type {
  BotOnboardingArea,
  BotOnboardingChoice,
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
import { chatMaxModeContextForToolbar } from "@/components/home/data/model-max-mode";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostsAdvertisingMethod } from "@/hooks/host/use-hosts-advertising-method";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useTeamOnboardingGate } from "@/hooks/bots/use-team-onboarding-gate";
import {
  useBotOnboardingChooseMutation,
  useBotOnboardingCompleteMutation,
} from "@/hooks/bots/use-bot-mutations";
import type { HostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import {
  chooseBotCreateHost,
  type BotCreateHostChoice,
} from "@/lib/home-bots/bot-create-host";
import { teamGithubDashboardUrl } from "@/lib/sandboxes/secrets-dashboard";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
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
  const {
    environmentId,
    teamName,
    connectableHostIds,
    environmentBindings,
    data,
  } = props;
  const tabClient = useTabHostClient();
  const choose = useBotOnboardingChooseMutation(tabClient);

  const localHostId = useReactiveLocalHostId();
  const effectiveHostId = useEffectiveHostId();
  const completingHostIds = useHostsAdvertisingMethod(
    connectableHostIds,
    "bot.onboarding.complete",
  );
  const hostChoice = chooseBotCreateHost({
    environmentId,
    localHostId,
    effectiveHostId,
    connectableHostIds,
    bindings: environmentBindings.byHostId,
    failedHostIds: environmentBindings.failedHostIds,
    creatingHostIds: completingHostIds,
  });
  const pending = pendingOf(data);
  const hostId = completionHostId(pending, completingHostIds, hostChoice);
  const namedClient = useHostClientForHostId(hostId);
  const createClient = hostId === null ? null : namedClient;
  const complete = useBotOnboardingCompleteMutation(createClient);
  const toolbarStore = useComposerToolbarStore(
    null,
    fallbackSeedSource(null, createClient),
    null,
    // The chosen host's last-used buckets, the machine the bots will run on.
    {
      hostClient: createClient,
      hostId,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
    },
  );
  const modelSlug = useStore(toolbarStore, (s) => s.selection.modelSlug);
  const reasoning = useStore(toolbarStore, (s) => s.reasoning);
  const maxModeContext = useMemo(
    () => chatMaxModeContextForToolbar(reasoning, ""),
    [reasoning],
  );
  const openBotTab = useBotTabsStore((s) => s.openBotTab);
  const navigate = useNavigate();

  const defaultAreas = useMemo(
    () =>
      data.catalog.filter((entry) => entry.tickedByDefault).map((e) => e.area),
    [data.catalog],
  );
  // A choice being sent shows as made; the mutation stays pending until the
  // read carries it back.
  const chosen: ReadonlyArray<string> = choose.isPending
    ? choose.variables.areas
    : (data.choice?.areas ?? defaultAreas);
  const toggle = (area: string, checked: boolean): void => {
    const areas = checked
      ? [...chosen.filter((a) => a !== area), area]
      : chosen.filter((a) => a !== area);
    choose.mutate({ environmentId, areas });
  };

  const busy = choose.isPending || complete.isPending;
  const canOpen =
    data.unlocked &&
    hostId !== null &&
    chosen.length > 0 &&
    modelSlug.length > 0 &&
    !busy;

  const openChannels = (): void => {
    if (!canOpen) return;
    const toolbar = toolbarStore.getState();
    const areas = [...chosen];
    // `mutateAsync`, as the create form's submit: the continuation opens the
    // channel through module-level actions whether or not the card is still
    // mounted. A failure is already toasted by the mutations.
    void (async () => {
      // The host creates the team's kept choice; one never made is the
      // default the boxes show.
      if (data.choice === null) {
        await choose.mutateAsync({ environmentId, areas });
      }
      const response = await complete.mutateAsync({
        environmentId,
        harness: toolbar.selection.harnessId,
        model: toolbar.selection.modelSlug,
        effort: toolbar.reasoning.length === 0 ? null : toolbar.reasoning,
        profile: toolbar.selection.profileId,
      });
      if (response.bots.length === 0) return;
      const first = response.bots[0];
      const title =
        data.catalog.find((entry) => entry.area === first.area)?.title ??
        first.area;
      openBotTab({ botId: first.botId, hostId, title });
      navigateToTabIntent(navigate, botTabIntent(first.botId), undefined);
    })().catch(() => undefined);
  };

  return (
    <div
      data-testid="bot-onboarding-card"
      className="flex flex-col gap-3 rounded-md border border-border/60 bg-foreground/3 p-3"
    >
      <StepTrail unlocked={data.unlocked} />
      <GithubStep github={data.github} teamName={teamName} />
      <BotsStep
        catalog={data.catalog}
        chosen={chosen}
        pendingAreas={pending.map((entry) => entry.area)}
        disabled={complete.isPending}
        onToggle={toggle}
      />
      {data.unlocked && pending.length === 0 && hostChoice.kind !== "chosen" ? (
        <CreateBotNoHost
          checking={hostChoice.kind === "checking"}
          environmentLabel={teamName}
          someUnchecked={environmentBindings.failedHostIds.length > 0}
          onRetry={environmentBindings.retryFailed}
        />
      ) : null}
      {data.unlocked ? (
        <div className="flex min-w-0">
          <HarnessModelPicker
            labelDisplay="responsive"
            maxModeContext={maxModeContext}
            store={toolbarStore}
            withServiceTier={false}
            withReasoning
            tuiOnly={false}
            lockedHarnessId={null}
            disabled={busy || hostId === null}
            registerActivation={false}
            createProfileHostId={hostId}
            runTargetHostId={hostId}
            terminalLoginSurface={null}
            profileAdmission={null}
            embedding={null}
          />
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!canOpen}
          data-testid="bot-onboarding-open"
          onClick={openChannels}
        >
          {complete.isPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Open your channels
        </Button>
      </div>
    </div>
  );
}

/** The chosen areas whose bot another host has not finished yet. */
function pendingOf(
  data: BotOnboardingReadResponse,
): BotOnboardingChoice["pending"] {
  return data.choice?.pending ?? [];
}

/**
 * Where "Open your channels" sends the completion. While an area is pending,
 * only its own host can finish it: there, when this client reaches it, or
 * nowhere until it does. Otherwise the host the app picks for the bots.
 */
function completionHostId(
  pending: BotOnboardingChoice["pending"],
  completingHostIds: ReadonlySet<string>,
  hostChoice: BotCreateHostChoice,
): string | null {
  if (pending.length > 0) {
    return (
      pending
        .map((entry) => entry.hostId)
        .find((id) => id !== null && completingHostIds.has(id)) ?? null
    );
  }
  return hostChoice.kind === "chosen" ? hostChoice.hostId : null;
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

function BotsStep(props: {
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

function GithubStep(props: {
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
