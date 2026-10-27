import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type { SandboxGrantsSummary } from "@traycer/protocol/host/sandbox-secrets";
import type {
  SandboxCost,
  SandboxHourlyPrice,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SandboxRunwayWarningLine } from "@/components/hosts/sandbox-balance-banner";
import { SandboxDestroyDialog } from "@/components/hosts/sandbox-confirm-dialogs";
import { SandboxOperationFailure } from "@/components/hosts/sandbox-operation-failure";
import { toastSandboxVerbOutcome } from "@/components/hosts/sandbox-confirm-model";
import {
  formatSandboxDay,
  SANDBOX_CARD_ACTION_LABEL,
  sandboxCardActions,
  sandboxCardShowsCostView,
  sandboxCreatorLine,
  sandboxGuestConfigFailure,
  sandboxHostVouches,
  sandboxIdleLine,
  sandboxPodRoomLine,
  sandboxSecretsReadiness,
  sandboxStateLine,
  sandboxSuspendKeepsLine,
  sandboxTeamFrozenStateLine,
  sandboxWakePayerLine,
  type SandboxCardAction,
} from "@/components/hosts/sandbox-card-model";
import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import type { HostScopeSandbox } from "@/components/settings/host-scope/host-scope-model";
import { sandboxStateWord } from "@/components/settings/host-scope/host-option-model";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useRefreshSandboxCosts } from "@/hooks/sandboxes/use-refresh-sandbox-costs";
import { useSandboxAutomation } from "@/hooks/sandboxes/use-sandbox-automation-query";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useSandboxCosts } from "@/hooks/sandboxes/use-sandbox-costs-query";
import { useSandboxDestroy } from "@/hooks/sandboxes/use-sandbox-destroy-mutation";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxRunwayWarning } from "@/hooks/sandboxes/use-sandbox-runway-warning";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import {
  useSandboxOperation,
  type SandboxRowOperation,
} from "@/hooks/sandboxes/use-sandbox-operation";
import { formatRelativeTimestamp, useSampledNow } from "@/lib/relative-time";
import { sandboxRegionLabel } from "@/lib/sandboxes/sandbox-row-lines";
import {
  formatRunway,
  sandboxBalanceMc,
  sandboxCostTodayMc,
  sandboxRunwayMinutes,
} from "@/lib/sandboxes/sandbox-balance";
import { formatMemory } from "@/lib/sandboxes/sandbox-pricing";
import {
  awakeAndRestingRates,
  formatSandboxCost,
  formatSandboxDollars,
  hourlyRate,
  sandboxVerbPendingLine,
} from "@/lib/sandboxes/sandbox-strings";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useSandboxEgressEvents } from "@/hooks/sandboxes/use-sandbox-egress-events";
import { useSandboxGrants } from "@/hooks/sandboxes/use-sandbox-grants-query";
import {
  sandboxGitHubLine,
  SANDBOX_STAND_IN_CLAUSE,
  sandboxGrantViews,
  sandboxHasBrokeredGrant,
  sandboxRouteAddresses,
  type SandboxGrantView,
} from "@/lib/sandboxes/sandbox-grants-view";
import { useSandboxRepairGuestConfiguration } from "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation";
import {
  sandboxCardEgressEventLines,
  type SandboxEgressEventLine,
} from "@/lib/sandboxes/sandbox-egress-event-line";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The card a sandbox host shows above its identity card in Settings: its
 * state with that state's copy and actions (`sandbox-card-model.ts`), shape,
 * region, rate, idle rule and last activity, the guest's configuration
 * failure when the heartbeat reports one, its brokered secrets (readiness,
 * the last typed egress events, repair), the cost view, and the balance.
 *
 * A frozen sandbox (out of credits) shows the frozen line with its destroy
 * date and the balance, and offers only destroy, behind a typed
 * confirmation.
 *
 * A team sandbox says who created it and whose bundle the running wake is
 * on, and always asks for its name before a destroy. It has no personal cost
 * view: the cost read lists only the person's own sandboxes. A team pod says how
 * many more shells it has room for instead.
 */
export function SandboxCard(props: {
  readonly hostName: string;
  /** The sandbox host's own health, which gates the secrets readiness line. */
  readonly hostState: HostHealthState;
  readonly sandbox: HostScopeSandbox;
  /**
   * Called once a destroy has settled (the sandbox is gone), for a row the
   * destroy removes from the host list; `null` when the row outlives it.
   */
  readonly onDestroyed: (() => void) | null;
}): ReactNode {
  // Taken as resolved. The builder (`sandboxFactsOf`) already prefers the
  // host list's facts and falls back to the sandbox-list summary, so a second
  // fallback here would let a stale summary's `frozen` undo a resolved thaw.
  const { summary, state, frozen, teamOwned } = props.sandbox;
  const word = sandboxStateWord(props.sandbox);
  const actions =
    summary === null
      ? []
      : sandboxCardActions(state, frozen, summary.kind, teamOwned);
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return (
    <Card
      size="sm"
      data-testid="sandbox-card"
      data-state={state ?? "unknown"}
      data-frozen={frozen ? "true" : "false"}
    >
      <CardHeader>
        <CardTitle>{summary?.displayName ?? props.hostName}</CardTitle>
        <CardDescription data-testid="sandbox-card-state-line">
          {cardStateLine(props.sandbox, viewerUserId)}
        </CardDescription>
        {word === null ? null : (
          <CardAction>
            <Badge
              variant={stateBadgeVariant(state, frozen)}
              data-testid="sandbox-card-state"
            >
              {capitalize(word)}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {summary === null ? (
          <SandboxDetailsMissing state={state} />
        ) : (
          <>
            <SandboxFacts
              summary={summary}
              teamOwned={teamOwned}
              state={state}
              frozen={frozen}
              viewerUserId={viewerUserId}
            />
            <SandboxPodRoom summary={summary} teamOwned={teamOwned} />
            <SandboxGuestConfigFailure summary={summary} />
            <SandboxSecretsSection
              summary={summary}
              state={state}
              frozen={frozen}
              hostState={props.hostState}
            />
            {sandboxCardShowsCostView(teamOwned) ? (
              <SandboxCostView
                sandboxId={summary.id}
                frozen={frozen}
                automation={summary.kind === "automation"}
              />
            ) : null}
          </>
        )}
      </CardContent>
      {summary === null ? null : (
        <SandboxCardFooter
          summary={summary}
          actions={actions}
          frozen={frozen}
          teamOwned={teamOwned}
          onDestroyed={props.onDestroyed}
        />
      )}
    </Card>
  );
}

/**
 * What the card says when the sandbox list has no row for it, from the list
 * read's own status: still being read, failed (with Retry), or answered
 * without this sandbox. The last is how a destroyed sandbox looks (the list
 * leaves destroyed rows out while the host list keeps them); any other state
 * missing from an answered list is a list that has not caught up, so it
 * offers Refresh.
 */
function SandboxDetailsMissing(props: {
  readonly state: HostSandboxState | null;
}): ReactNode {
  const list = useSandboxList();
  const unavailable = useSandboxControlUnavailableReason();
  const listed = list.data !== undefined && list.data !== null;
  // A build that cannot reach the control plane never reads the list: say
  // why, rather than "Loading" forever.
  if (unavailable !== null) {
    return (
      <p
        className="text-ui-xs text-muted-foreground"
        data-testid="sandbox-card-details-unavailable"
      >
        {unavailable}
      </p>
    );
  }
  if (!listed && !list.isError) {
    return (
      <p className="text-ui-xs text-muted-foreground">
        Loading this sandbox&apos;s details…
      </p>
    );
  }
  if (listed && props.state === "destroyed") {
    return (
      <p
        className="text-ui-xs text-muted-foreground"
        data-testid="sandbox-card-details-destroyed"
      >
        This sandbox was destroyed.
      </p>
    );
  }
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={
        listed ? "sandbox-card-details-absent" : "sandbox-card-details-failed"
      }
    >
      <p className="text-ui-xs text-muted-foreground">
        {listed
          ? "Not in your sandbox list."
          : "Couldn't load this sandbox's details."}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={list.isFetching}
        data-testid="sandbox-card-details-reload"
        onClick={() => void list.refetch()}
      >
        {list.isFetching ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        {listed ? "Refresh" : "Retry"}
      </Button>
    </div>
  );
}

function SandboxFacts(props: {
  readonly summary: SandboxSummary;
  readonly teamOwned: boolean;
  readonly state: HostSandboxState | null;
  readonly frozen: boolean;
  readonly viewerUserId: string | null;
}): ReactNode {
  const { summary } = props;
  // A team row's creator and wake payer; a personal row is the viewer's own.
  const creator = props.teamOwned
    ? sandboxCreatorLine(summary, props.viewerUserId)
    : null;
  const payer = props.teamOwned
    ? sandboxWakePayerLine(
        props.state,
        props.frozen,
        summary,
        props.viewerUserId,
      )
    : null;
  const now = useSampledNow();
  const catalogue = useSandboxCatalogue(true).data ?? null;
  const provider =
    catalogue?.providers.find(
      (p) => p.provider === summary.provider && p.os.includes(summary.os),
    ) ?? null;
  const keeps =
    provider === null
      ? null
      : sandboxSuspendKeepsLine(provider.suspendFidelity);
  const regionLabel = sandboxRegionLabel(summary);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-xs">
      <dt className="text-muted-foreground">Size</dt>
      <dd data-testid="sandbox-card-shape">
        {formatShape(summary.cpus, summary.memoryMb, summary.diskMb)}
      </dd>
      {regionLabel === null ? null : (
        <>
          <dt className="text-muted-foreground">Region</dt>
          <dd data-testid="sandbox-card-region">{regionLabel}</dd>
        </>
      )}
      <dt className="text-muted-foreground">Rate</dt>
      <dd data-testid="sandbox-card-rate">
        {summary.kind === "automation"
          ? "Free"
          : formatRate(summary.priceMcPerHour)}
      </dd>
      <dt className="text-muted-foreground">Idle</dt>
      <dd data-testid="sandbox-card-idle">{sandboxIdleLine(summary)}</dd>
      {keeps === null || summary.burst ? null : (
        <>
          <dt className="text-muted-foreground">Suspend</dt>
          <dd data-testid="sandbox-card-suspend-keeps">{keeps}</dd>
        </>
      )}
      <dt className="text-muted-foreground">Last active</dt>
      <dd data-testid="sandbox-card-last-active">
        {summary.lastActivityAt === null
          ? "No activity reported yet"
          : formatRelativeTimestamp(summary.lastActivityAt, now)}
      </dd>
      {summary.burst ? (
        <>
          <dt className="text-muted-foreground">Created by</dt>
          <dd>An agent, for one task</dd>
        </>
      ) : null}
      {creator === null || summary.burst ? null : (
        <>
          <dt className="text-muted-foreground">Creator</dt>
          <dd data-testid="sandbox-card-creator">{creator}</dd>
        </>
      )}
      {payer === null ? null : (
        <>
          <dt className="text-muted-foreground">Wake</dt>
          <dd data-testid="sandbox-card-wake-payer">{payer}</dd>
        </>
      )}
    </dl>
  );
}

/** A frozen team sandbox names whose bundle is out; every other row as before. */
function cardStateLine(
  sandbox: HostScopeSandbox,
  viewerUserId: string | null,
): string {
  const { summary, state, frozen } = sandbox;
  return sandbox.teamOwned && frozen
    ? sandboxTeamFrozenStateLine(summary, viewerUserId)
    : sandboxStateLine(state, frozen, summary);
}

/**
 * The room line, on a team pod only. A pod row without an environment (a
 * server from before environments) shows none: reading it with no
 * environment would read the person's own Automations host.
 */
function SandboxPodRoom(props: {
  readonly summary: SandboxSummary;
  readonly teamOwned: boolean;
}): ReactNode {
  const { summary } = props;
  if (!props.teamOwned || summary.kind !== "automation") return null;
  if (summary.environmentId === null) return null;
  return (
    <SandboxPodRoomLine
      environmentId={summary.environmentId}
      sandboxId={summary.id}
    />
  );
}

/**
 * A team pod's room for more shells, from its environment's pod list. Every
 * pod card of a team reads the same `GET /automation?environmentId=` (one
 * query per environment), so three pods cost one read.
 */
function SandboxPodRoomLine(props: {
  readonly environmentId: string;
  readonly sandboxId: string;
}): ReactNode {
  const automation = useSandboxAutomation(props.environmentId);
  const pod =
    automation.data?.pods.find((p) => p.sandbox.id === props.sandboxId) ?? null;
  if (pod === null) return null;
  return (
    <p
      className="text-ui-xs text-muted-foreground"
      data-testid="sandbox-card-pod-room"
    >
      {sandboxPodRoomLine(pod.headroom, pod.liveShells)}
    </p>
  );
}

/**
 * Whether this sandbox's brokered secrets work right now
 * (`sandboxSecretsReadiness`), under its facts.
 */
function SandboxSecretsReadinessLine(props: {
  readonly summary: SandboxSummary;
  readonly state: HostSandboxState | null;
  readonly frozen: boolean;
  readonly hostState: HostHealthState;
}): ReactNode {
  const readiness = sandboxSecretsReadiness(
    props.state,
    props.frozen,
    props.summary,
    props.hostState,
  );
  if (readiness === null) return null;
  return (
    <p
      data-testid="sandbox-card-secrets-readiness"
      data-tone={readiness.tone}
      className={cn(
        "text-ui-xs leading-snug break-words",
        readiness.tone === "ready" && "text-success-foreground",
        readiness.tone === "pending" && "text-muted-foreground",
        readiness.tone === "degraded" && "text-warning-foreground",
      )}
    >
      <span className="text-muted-foreground">Secrets: </span>
      {readiness.text}
    </p>
  );
}

function SandboxGuestConfigFailure(props: {
  readonly summary: SandboxSummary;
}): ReactNode {
  const failure = sandboxGuestConfigFailure(props.summary);
  if (failure === null) return null;
  return (
    <p
      data-testid="sandbox-card-guest-config-failure"
      className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-ui-xs leading-snug break-words text-destructive"
    >
      {failure}
    </p>
  );
}

/**
 * The cost view: what this sandbox accrues now, what it cost today, and what
 * the meter has charged since it was created (compute and storage), from the
 * control plane's ledger; then the balance and how long it covers the
 * account's awake burn, and the two-hour and thirty-minute warnings. The
 * Automations host's day reads Free, as its rate does.
 */
function SandboxCostView(props: {
  readonly sandboxId: string;
  readonly frozen: boolean;
  readonly automation: boolean;
}): ReactNode {
  // Also mounted by the host list's banner; the hook elects one owner, so a
  // change is still one invalidation (and a phone, which shows the card
  // without the banner, still refreshes).
  useRefreshSandboxCosts();
  const costs = useSandboxCosts();
  const user = useAuthUser().data ?? null;
  const warning = useSandboxRunwayWarning();
  const now = useSampledNow();
  const cost =
    costs.data?.sandboxes.find((c) => c.sandboxId === props.sandboxId) ?? null;
  const balanceMc = sandboxBalanceMc(user);
  const burn = costs.data?.awakeBurnMillicreditsPerHour ?? null;
  return (
    <div className="flex flex-col gap-1" data-testid="sandbox-card-cost">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-xs">
        {cost === null ? (
          <>
            <dt className="text-muted-foreground">Cost</dt>
            <dd className="text-muted-foreground">
              {costs.isError ? "Couldn't load the cost" : "Loading…"}
            </dd>
          </>
        ) : (
          <SandboxCostFacts
            cost={cost}
            now={now}
            automation={props.automation}
          />
        )}
        <dt className="text-muted-foreground">Balance</dt>
        <dd data-testid="sandbox-card-balance">
          {formatBalance(balanceMc, burn, props.frozen)}
        </dd>
      </dl>
      <SandboxRunwayWarningLine warning={warning} />
    </div>
  );
}

function SandboxCostFacts(props: {
  readonly cost: SandboxCost;
  readonly now: number;
  readonly automation: boolean;
}): ReactNode {
  const { cost } = props;
  const charged =
    cost.charged.computeMillicredits + cost.charged.storageMillicredits;
  return (
    <>
      <dt className="text-muted-foreground">Now</dt>
      <dd data-testid="sandbox-card-cost-now">
        {cost.currentRateMillicreditsPerHour === 0
          ? "Not billing"
          : hourlyRate(cost.currentRateMillicreditsPerHour)}
      </dd>
      <dt className="text-muted-foreground">Today</dt>
      <dd data-testid="sandbox-card-cost-today">
        {props.automation
          ? "Free"
          : formatSandboxCost(sandboxCostTodayMc(cost, props.now))}
      </dd>
      <dt className="text-muted-foreground">Charged</dt>
      <dd data-testid="sandbox-card-cost-charged">
        {`${formatSandboxCost(charged)} since ${formatSandboxDay(cost.charged.sinceCreatedAt)} (${formatSandboxCost(cost.charged.computeMillicredits)} compute · ${formatSandboxCost(cost.charged.storageMillicredits)} storage)`}
        {cost.pendingMillicredits > 0
          ? ` · ${formatSandboxCost(cost.pendingMillicredits)} pending`
          : null}
      </dd>
    </>
  );
}

/**
 * The sandbox's secrets, the one place on the card that speaks of them:
 * whether brokered traffic flows right now, the secrets it may use with each
 * destination's own readiness, what the forwarder and the gateway last
 * refused or closed, the repair action for its setup, and how a container
 * reaches a brokered destination.
 *
 * The grants are the broker's answer and show for a sleeping sandbox too;
 * everything that talks to the sandbox itself waits until it reports a phase.
 */
function SandboxSecretsSection(props: {
  readonly summary: SandboxSummary;
  readonly state: HostSandboxState | null;
  readonly frozen: boolean;
  readonly hostState: HostHealthState;
}): ReactNode {
  const { summary } = props;
  const grants = useSandboxGrants(summary.environmentId, summary.hostId);
  const grantsSummary = grants.data ?? null;
  // A sandbox with no phase and no grant set has no secrets to speak of (a
  // server or broker from before them): the section, and every live hook
  // below it, stays unmounted.
  if (summary.phase === null && grantsSummary === null) return null;
  const awake = props.state === "awake" && !props.frozen;
  return (
    <section
      className="flex flex-col gap-1.5"
      data-testid="sandbox-card-secrets"
      aria-label="Secrets"
    >
      <SandboxSecretsReadinessLine
        summary={summary}
        state={props.state}
        frozen={props.frozen}
        hostState={props.hostState}
      />
      <SandboxGrantsList
        summary={grantsSummary}
        // What the host last reported per route is shown only while its host
        // vouches for it; the broker's own word on a route always is.
        routes={sandboxHostVouches(props.hostState) ? summary.routes : null}
        failed={grants.isError}
        refetching={grants.isFetching}
        onRetry={() => void grants.refetch()}
      />
      {summary.phase === null ? null : (
        <SandboxSecretsLive
          // Events are one host's: a card re-pointed at another sandbox must
          // not show the last one's.
          key={summary.hostId}
          hostId={summary.hostId}
          awake={awake}
          routeAddresses={sandboxRouteAddresses(grantsSummary)}
        />
      )}
    </section>
  );
}

/**
 * What this sandbox may use: each secret, how it holds it, and for a brokered
 * one each destination with its own first-use readiness. The broker's answer,
 * joined with what the sandbox last reported per route.
 */
function SandboxGrantsList(props: {
  readonly summary: SandboxGrantsSummary | null;
  readonly routes: SandboxSummary["routes"];
  readonly failed: boolean;
  readonly refetching: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  const { summary } = props;
  if (summary === null) {
    if (!props.failed) return null;
    return (
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="sandbox-card-grants-failed"
      >
        <p className="text-ui-xs text-muted-foreground">
          Couldn&apos;t load this sandbox&apos;s secrets.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.refetching}
          data-testid="sandbox-card-grants-retry"
          onClick={props.onRetry}
        >
          {props.refetching ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Retry
        </Button>
      </div>
    );
  }
  const views = sandboxGrantViews(summary, props.routes);
  return (
    <div className="flex flex-col gap-1" data-testid="sandbox-card-grants">
      {sandboxHasBrokeredGrant(summary) ? (
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="sandbox-card-stand-in"
        >
          {SANDBOX_STAND_IN_CLAUSE}
        </p>
      ) : null}
      {views.length === 0 ? (
        <p className="text-ui-xs text-muted-foreground">
          No secrets are granted to this sandbox.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {views.map((view) => (
            <SandboxGrantRow key={view.secretName} view={view} />
          ))}
        </ul>
      )}
      {summary.github === null ? null : (
        <p
          className="text-ui-xs break-words text-muted-foreground"
          data-testid="sandbox-card-github"
        >
          {sandboxGitHubLine(summary.github)}
        </p>
      )}
    </div>
  );
}

function SandboxGrantRow(props: {
  readonly view: SandboxGrantView;
}): ReactNode {
  const { view } = props;
  return (
    <li
      className="text-ui-xs leading-snug break-words"
      data-testid="sandbox-card-grant"
    >
      <p>
        <span className="font-medium">{view.secretName}</span>
        <span
          className={cn(
            view.exposed ? "text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {" · "}
          {view.modeLine}
        </span>
        {view.via === null ? null : (
          <span className="text-muted-foreground">
            {" · "}
            {view.via}
          </span>
        )}
        {view.source === null ? null : (
          <span className="text-muted-foreground">
            {" · "}
            {view.source}
          </span>
        )}
      </p>
      {view.routes.length === 0 ? null : (
        <ul className="flex flex-col pl-3">
          {view.routes.map((route) => (
            <li
              key={route.route}
              data-testid="sandbox-card-grant-route"
              data-readiness={route.readiness ?? "unknown"}
            >
              <span>{route.address}</span>
              {route.readinessText === null ? null : (
                <span
                  className={cn(
                    route.readiness === "ready" && "text-success-foreground",
                    route.readiness === "pending" && "text-muted-foreground",
                    route.readiness === "unavailable" &&
                      "text-warning-foreground",
                  )}
                >
                  {" · "}
                  {route.readinessText}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {view.rotation === null ? null : (
        <p
          className={cn(
            "pl-3",
            view.rotation.tone === "success" && "text-success-foreground",
            view.rotation.tone === "warning" && "text-warning-foreground",
            view.rotation.tone === "muted" && "text-muted-foreground",
          )}
          data-testid="sandbox-card-grant-rotation"
        >
          {view.rotation.text}
        </p>
      )}
    </li>
  );
}

/**
 * The parts that talk to the sandbox host itself or only make sense once it
 * brokers: its last typed egress events, the repair action, and the Docker
 * note. The events stream opens only while the sandbox is awake, since a card
 * on screen is never a reason to hold a connection to a sleeping one.
 */
function SandboxSecretsLive(props: {
  readonly hostId: string;
  readonly awake: boolean;
  readonly routeAddresses: ReadonlyMap<string, string>;
}): ReactNode {
  const events = useSandboxEgressEvents(props.awake ? props.hostId : null);
  const lines = sandboxCardEgressEventLines(events);
  return (
    <>
      {lines.length === 0 ? null : (
        <ul
          className="flex flex-col gap-1.5"
          data-testid="sandbox-card-egress-events"
        >
          {lines.map((line) => (
            <SandboxEgressEventRow
              key={line.id}
              line={line}
              address={
                line.route === null
                  ? null
                  : (props.routeAddresses.get(line.route) ?? null)
              }
            />
          ))}
        </ul>
      )}
      {props.awake ? <SandboxRepairAction hostId={props.hostId} /> : null}
    </>
  );
}

function SandboxEgressEventRow(props: {
  readonly line: SandboxEgressEventLine;
  /** Where the event's route leads, when the grants summary names it. */
  readonly address: string | null;
}): ReactNode {
  const { line } = props;
  const now = useSampledNow();
  return (
    <li
      data-testid="sandbox-card-egress-event"
      data-tone={line.tone}
      className={cn(
        "rounded-md border px-2 py-1.5 text-ui-xs leading-snug break-words",
        line.tone === "notice"
          ? "border-border/60 text-muted-foreground"
          : "border-warning/30 bg-warning/10 text-warning-foreground",
      )}
    >
      <p className="font-medium">{line.headline}</p>
      <p>{line.description}</p>
      <p className="text-muted-foreground">
        {props.address === null ? null : `${props.address} · `}
        {formatRelativeTimestamp(line.at, now)}
        {line.reportedBySandbox ? " · reported by the sandbox" : null}
      </p>
    </li>
  );
}

/**
 * Re-applies the sandbox's setup (trust files, host aliases, environment, git)
 * and refetches it. Offered only on a host that serves the verb.
 */
function SandboxRepairAction(props: { readonly hostId: string }): ReactNode {
  const supported = useHostSupportsMethod(
    props.hostId,
    "host.sandbox.repairGuestConfiguration",
  );
  const repair = useSandboxRepairGuestConfiguration();
  const list = useSandboxList();
  if (!supported) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={repair.isPending}
        data-testid="sandbox-card-repair"
        onClick={() => {
          repair.mutate(
            {},
            {
              onSuccess: (result) => {
                if (result.guestConfigured) {
                  toast.success("Sandbox setup repaired");
                } else {
                  toast.warning(
                    result.guestConfigFailureReason === null
                      ? "Sandbox setup is still failing"
                      : `Sandbox setup is still failing: ${result.guestConfigFailureReason}`,
                  );
                }
                void list.refetch();
              },
            },
          );
        }}
      >
        {repair.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId="sandbox-card-repair-spinner"
            variant={undefined}
          />
        ) : null}
        Repair setup
      </Button>
      <span className="text-ui-xs text-muted-foreground">
        Re-applies its trust files, host aliases, variables and git setup.
      </span>
    </div>
  );
}

/** The card's actions. A sandbox is created from the pickers, not here. */
function SandboxCardFooter(props: {
  readonly summary: SandboxSummary;
  readonly actions: readonly SandboxCardAction[];
  readonly frozen: boolean;
  readonly teamOwned: boolean;
  readonly onDestroyed: (() => void) | null;
}): ReactNode {
  const operation = useSandboxOperation(props.summary.id);
  if (props.actions.length === 0 && operation === null) return null;
  return (
    <CardFooter className="flex flex-wrap gap-2">
      <SandboxActions
        summary={props.summary}
        actions={props.actions}
        frozen={props.frozen}
        teamOwned={props.teamOwned}
        onDestroyed={props.onDestroyed}
        operation={operation}
      />
    </CardFooter>
  );
}

function SandboxActions(props: {
  readonly summary: SandboxSummary;
  readonly actions: readonly SandboxCardAction[];
  readonly frozen: boolean;
  readonly teamOwned: boolean;
  readonly onDestroyed: (() => void) | null;
  readonly operation: SandboxRowOperation | null;
}): ReactNode {
  const { summary } = props;
  const verb = useSandboxVerb(summary.id);
  const destroy = useSandboxDestroy(summary);
  const pendingVerb =
    props.operation?.kind === "pending" ? props.operation.verb : null;
  return (
    <>
      {pendingVerb !== null && !props.actions.includes(pendingVerb) ? (
        <Button type="button" variant="outline" size="sm" disabled>
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
          <span role="status">{sandboxVerbPendingLine(pendingVerb)}</span>
        </Button>
      ) : null}
      {props.actions.map((action) =>
        action === "destroy" ? (
          // Not gated on a pending verb: a verb can wait out the server's
          // 300 s deadline, and destroy is the way out of one that will not
          // land (the server refuses it only while the row is mid-transition).
          <SandboxDestroyAction
            key={action}
            summary={summary}
            onDestroyed={props.onDestroyed}
          />
        ) : (
          <Button
            key={action}
            type="button"
            variant={
              action === "resume" || action === "start" ? "default" : "outline"
            }
            size="sm"
            disabled={pendingVerb !== null}
            data-testid={`sandbox-card-${action}`}
            onClick={() => {
              const run = (): void => {
                verb.mutate(action, {
                  onSuccess: (outcome) =>
                    toastSandboxVerbOutcome(
                      action,
                      outcome,
                      summary.displayName,
                    ),
                });
              };
              run();
            }}
          >
            {pendingVerb === action ? (
              <AgentSpinningDots
                className={undefined}
                testId={`sandbox-card-${action}-spinner`}
                variant={undefined}
              />
            ) : null}
            {pendingVerb === action ? (
              <span role="status">{sandboxVerbPendingLine(action)}</span>
            ) : (
              SANDBOX_CARD_ACTION_LABEL[action]
            )}
          </Button>
        ),
      )}
      <SandboxOperationFailure
        sandboxId={summary.id}
        name={summary.displayName}
        operation={props.operation}
        busy={pendingVerb !== null}
        onRetry={(pressed) => {
          if (pressed === "destroy") {
            destroy.mutate(undefined, {
              onSuccess: (gone) => {
                if (gone) props.onDestroyed?.();
              },
            });
          } else {
            verb.mutate(pressed, {
              onSuccess: (outcome) =>
                toastSandboxVerbOutcome(pressed, outcome, summary.displayName),
            });
          }
        }}
      />
    </>
  );
}

function SandboxDestroyAction(props: {
  readonly summary: SandboxSummary;
  readonly onDestroyed: (() => void) | null;
}): ReactNode {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const operation = useSandboxOperation(props.summary.id);
  const pending = operation?.kind === "pending" && operation.verb === "destroy";
  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={pending}
        data-testid="sandbox-card-destroy"
        onClick={() => setConfirmOpen(true)}
      >
        {pending ? (
          <AgentSpinningDots
            className={undefined}
            testId="sandbox-card-destroy-spinner"
            variant={undefined}
          />
        ) : null}
        {pending ? (
          <span role="status">{sandboxVerbPendingLine("destroy")}</span>
        ) : (
          "Destroy"
        )}
      </Button>
      <SandboxDestroyDialog
        sandbox={props.summary}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onDestroyed={props.onDestroyed}
      />
    </>
  );
}

function stateBadgeVariant(
  state: HostSandboxState | null,
  frozen: boolean,
): "success" | "info" | "warning" | "destructive" | "muted" {
  if (frozen) return "warning";
  switch (state) {
    case "awake":
      return "success";
    case "creating":
    case "resuming":
    case "starting":
    case "suspending":
    case "stopping":
      return "info";
    case "failed":
      return "destructive";
    case "suspended":
    case "stopped":
    case "destroying":
    case "destroyed":
    case "released":
    case null:
      return "muted";
  }
}

function formatShape(cpus: number, memoryMb: number, diskMb: number): string {
  const vcpu = `${cpus} vCPU`;
  return diskMb > 0
    ? `${vcpu} · ${formatMemory(memoryMb)} memory · ${formatMemory(diskMb)} disk`
    : `${vcpu} · ${formatMemory(memoryMb)} memory`;
}

function formatRate(price: SandboxHourlyPrice | null): string {
  if (price === null) return "Not priced here";
  return awakeAndRestingRates(price);
}

/**
 * The balance line: the credits sandboxes are charged against and how long
 * they cover the account's awake burn, in the warnings' own words. A frozen
 * card's state line already says what wakes it, so it gets the figure alone.
 */
function formatBalance(
  balanceMc: number | null,
  burnMcPerHour: number | null,
  frozen: boolean,
): string {
  if (balanceMc === null) return "Loading…";
  const balance = formatSandboxDollars(balanceMc);
  if (frozen || burnMcPerHour === null) return balance;
  const minutes = sandboxRunwayMinutes(balanceMc, burnMcPerHour);
  return minutes === null
    ? balance
    : `${balance}, about ${formatRunway(minutes)} at your current burn`;
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}
