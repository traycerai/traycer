import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { SandboxGrantsSummary } from "@traycer/protocol/host/sandbox-secrets";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type {
  SandboxCost,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { SandboxRunwayWarningLine } from "@/components/hosts/sandbox-balance-banner";
import { SandboxDestroyDialog } from "@/components/hosts/sandbox-confirm-dialogs";
import { SandboxOperationFailure } from "@/components/hosts/sandbox-operation-failure";
import { toastSandboxVerbOutcome } from "@/components/hosts/sandbox-confirm-model";
import {
  formatSandboxDay,
  SANDBOX_CARD_ACTION_LABEL,
  sandboxBilledPriceField,
  sandboxCardActions,
  sandboxHeaderPrimaryAction,
  sandboxCardShowsCostView,
  sandboxCreatorName,
  sandboxGuestConfigFailure,
  sandboxHostVouches,
  sandboxIdleLine,
  sandboxOperationalLine,
  sandboxPodRoomLine,
  sandboxSecretsReadiness,
  sandboxHeaderCreditsLine,
  sandboxHeaderNeedsRepair,
  sandboxHeaderFailureLine,
  sandboxSuspendKeepsLine,
  sandboxWakePayerName,
  sandboxWithdrawalLine,
  type SandboxCardAction,
  type SandboxSecretsReadiness,
} from "@/components/hosts/sandbox-card-model";
import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import type { HostScopeSandbox } from "@/components/settings/host-scope/host-scope-model";
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
  sandboxOperationShown,
  useSandboxOperation,
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
  sandboxRouteAddresses,
  SANDBOX_STAND_IN_CLAUSE,
  sandboxHasBrokeredGrant,
  sandboxGrantViews,
  sandboxGitHubLine,
  type SandboxGrantView,
  sandboxSecretsSummary,
  type SandboxSecretsLine,
} from "@/lib/sandboxes/sandbox-grants-view";
import { useSandboxRepairGuestConfiguration } from "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation";
import {
  sandboxCardEgressEventLines,
  type SandboxEgressEventLine,
} from "@/lib/sandboxes/sandbox-egress-event-line";
import { cn } from "@/lib/utils";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openEnvironmentPage } from "@/components/settings/environment/open-environment-page";
import { PERSONAL_CONFIGURATION_ID } from "@/lib/settings-environment-pages";
import { useAuthStore } from "@/stores/auth/auth-store";

/** The Sandbox section contains facts; lifecycle actions live in the header. */
export function SandboxCard(props: {
  readonly hostState: HostHealthState;
  readonly sandbox: HostScopeSandbox;
}): ReactNode {
  const { summary, state, frozen, teamOwned } = props.sandbox;
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const operationalLine = sandboxOperationalLine(state, frozen);
  return (
    <div
      className="flex min-w-0 flex-col gap-5 p-5"
      data-testid="sandbox-card"
      data-state={state ?? "unknown"}
      data-frozen={frozen ? "true" : "false"}
    >
      {operationalLine === null ? null : (
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="sandbox-card-operational-line"
        >
          {operationalLine}
        </p>
      )}
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
          <SandboxSecretsSection
            summary={summary}
            state={state}
            frozen={frozen}
            hostState={props.hostState}
            teamOwned={teamOwned}
          />
          {sandboxCardShowsCostView(teamOwned) ? (
            <details className="border-t border-border/50 pt-3">
              <summary className="cursor-pointer text-ui-xs">
                Cost details
              </summary>
              <SandboxCostView sandboxId={summary.id} frozen={frozen} />
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Rates belong beside the state; a team's sandbox has no personal ledger. */
export function SandboxHeaderCost(props: {
  readonly sandbox: HostScopeSandbox;
}): ReactNode {
  const { summary, state, frozen, teamOwned } = props.sandbox;
  if (summary === null) return null;
  return teamOwned ? (
    <SandboxHeaderRate
      summary={summary}
      state={state}
      frozen={frozen}
      cost={null}
    />
  ) : (
    <SandboxPersonalHeaderCost
      summary={summary}
      state={state}
      frozen={frozen}
    />
  );
}

function SandboxHeaderRate(props: {
  readonly summary: SandboxSummary;
  readonly state: HostSandboxState | null;
  readonly frozen: boolean;
  readonly cost: SandboxCost | null;
}): ReactNode {
  return (
    <>
      <span aria-hidden>·</span>
      <span>
        {formatHeaderRate(props.summary, props.state, props.frozen, props.cost)}
      </span>
    </>
  );
}

function formatHeaderRate(
  summary: SandboxSummary,
  state: HostSandboxState | null,
  frozen: boolean,
  cost: SandboxCost | null,
): string {
  if (summary.kind === "automation") return "Free";
  if (cost !== null)
    return cost.currentRateMillicreditsPerHour === 0
      ? "Not billing"
      : hourlyRate(cost.currentRateMillicreditsPerHour);
  // Without a ledger (a team's sandbox, or a personal ledger not read yet),
  // the list price of the state's own tier is the rate. A frozen sandbox and
  // a state that accrues nothing are not billing: the list price is not
  // their rate.
  if (frozen) return "Not billing";
  const field = sandboxBilledPriceField(state ?? summary.state);
  if (field === null) return "Not billing";
  const price = summary.priceMcPerHour;
  if (price === null) return "Not priced here";
  return hourlyRate(price[field]);
}

function SandboxPersonalHeaderCost(props: {
  readonly summary: SandboxSummary;
  readonly state: HostSandboxState | null;
  readonly frozen: boolean;
}): ReactNode {
  useRefreshSandboxCosts();
  const costs = useSandboxCosts();
  const now = useSampledNow();
  const cost =
    costs.data?.sandboxes.find((item) => item.sandboxId === props.summary.id) ??
    null;
  return (
    <>
      <SandboxHeaderRate
        summary={props.summary}
        state={props.state}
        frozen={props.frozen}
        cost={cost}
      />
      {cost === null ? null : (
        <>
          <span aria-hidden>·</span>
          <span data-testid="sandbox-card-cost-today">
            {props.summary.kind === "automation"
              ? "Free today"
              : `${formatSandboxCost(sandboxCostTodayMc(cost, now))} today`}
          </span>
        </>
      )}
    </>
  );
}

export function SandboxHeaderNotices(props: {
  readonly sandbox: HostScopeSandbox;
  readonly teamName: string | null;
}): ReactNode {
  const { summary, frozen, teamOwned } = props.sandbox;
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const credits = sandboxHeaderCreditsLine(
    summary,
    teamOwned,
    props.teamName,
    viewerUserId,
  );
  const failure = sandboxHeaderFailureLine(props.sandbox);
  return (
    <div className="flex shrink-0 flex-col gap-2 px-5 text-ui-xs">
      {frozen ? (
        <p
          className="pb-3 text-warning-foreground"
          data-testid="sandbox-card-state-line"
        >
          {credits}
        </p>
      ) : null}
      {failure === null ? null : (
        <p
          className="pb-3 text-warning-foreground"
          data-testid="sandbox-card-state-line"
        >
          {failure}
        </p>
      )}
      {summary === null ? null : (
        <>
          <SandboxWithdrawalNotice summary={summary} />
          <SandboxGuestConfigFailure summary={summary} />
        </>
      )}
    </div>
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
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui-xs">
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
      <SandboxOtherRate summary={summary} state={props.state} />
      <dt className="text-muted-foreground">Idle policy</dt>
      <dd className="min-w-0 wrap-anywhere" data-testid="sandbox-card-idle">
        {sandboxIdleLine(summary, props.state)}
        {/* What a suspend keeps: an Automations row is never suspended, and a
            burst row is destroyed instead. */}
        {keeps === null || summary.burst || summary.kind === "automation"
          ? null
          : ` · ${keeps}`}
      </dd>
      <dt className="text-muted-foreground">Last active</dt>
      <dd data-testid="sandbox-card-last-active">
        {summary.lastActivityAt === null
          ? "No activity reported yet"
          : formatRelativeTimestamp(summary.lastActivityAt, now)}
      </dd>
      <SandboxProvenance
        summary={summary}
        teamOwned={props.teamOwned}
        state={props.state}
        frozen={props.frozen}
        viewerUserId={props.viewerUserId}
      />
    </dl>
  );
}

/** The header states the current rate; these facts retain the other rate. */
function SandboxOtherRate(props: {
  readonly summary: SandboxSummary;
  readonly state: HostSandboxState | null;
}): ReactNode {
  const price = props.summary.priceMcPerHour;
  if (price === null || props.summary.kind === "automation") return null;
  const state = props.state ?? props.summary.state;
  if (state === "destroying" || state === "destroyed") return null;
  const field = sandboxBilledPriceField(state);
  const resting = field === "suspendedMc" || field === "stoppedMc";
  const rate = resting
    ? price.awakeMc
    : Math.max(price.suspendedMc, price.stoppedMc);
  return (
    <>
      <dt className="text-muted-foreground">
        {resting ? "Awake rate" : "Storage rate"}
      </dt>
      <dd data-testid="sandbox-card-other-rate">{hourlyRate(rate)}</dd>
    </>
  );
}

function SandboxProvenance(props: {
  readonly summary: SandboxSummary;
  readonly teamOwned: boolean;
  readonly state: HostSandboxState | null;
  readonly frozen: boolean;
  readonly viewerUserId: string | null;
}): ReactNode {
  const { summary } = props;
  // A team row's creator and wake payer; a personal row is the viewer's own.
  const creator = props.teamOwned
    ? sandboxCreatorName(summary, props.viewerUserId)
    : null;
  const payer = props.teamOwned
    ? sandboxWakePayerName(
        props.state,
        props.frozen,
        summary,
        props.viewerUserId,
      )
    : null;
  return (
    <>
      {summary.burst ? (
        <>
          <dt className="text-muted-foreground">Created by</dt>
          <dd>An agent, for one task</dd>
        </>
      ) : null}
      {creator === null || summary.burst ? null : (
        <>
          <dt className="text-muted-foreground">Created by</dt>
          <dd data-testid="sandbox-card-creator">{creator}</dd>
        </>
      )}
      {payer === null ? null : (
        <>
          <dt className="text-muted-foreground">Wake payer</dt>
          <dd data-testid="sandbox-card-wake-payer">{payer}</dd>
        </>
      )}
    </>
  );
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
 * When this sandbox stops running, on a row whose kind the control plane is
 * withdrawing. Nothing is broken and nothing is lost yet, so it is a
 * warning: the end is ahead and the person can still move what they want to
 * keep.
 */
function SandboxWithdrawalNotice(props: {
  readonly summary: SandboxSummary;
}): ReactNode {
  const line = sandboxWithdrawalLine(
    props.summary.withdrawalEndsAt,
    props.summary.destroyAt,
  );
  if (line === null) return null;
  return (
    <p
      data-testid="sandbox-card-withdrawal"
      className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 mb-3 text-ui-xs leading-snug wrap-anywhere text-warning-foreground"
    >
      {line}
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
      className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 mb-3 text-ui-xs leading-snug wrap-anywhere text-destructive"
    >
      {failure}
    </p>
  );
}

/**
 * The personal ledger and balance, separate from the rates and today's total.
 */
function SandboxCostView(props: {
  readonly sandboxId: string;
  readonly frozen: boolean;
}): ReactNode {
  // Also mounted by the host list's banner; the hook elects one owner, so a
  // change is still one invalidation (and a phone, which shows the card
  // without the banner, still refreshes).
  useRefreshSandboxCosts();
  const costs = useSandboxCosts();
  const user = useAuthUser().data ?? null;
  const warning = useSandboxRunwayWarning();
  const cost =
    costs.data?.sandboxes.find((c) => c.sandboxId === props.sandboxId) ?? null;
  const balanceMc = sandboxBalanceMc(user);
  const burn = costs.data?.awakeBurnMillicreditsPerHour ?? null;
  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="sandbox-card-cost">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui-xs">
        {cost === null ? (
          <>
            <dt className="text-muted-foreground">Cost</dt>
            <dd className="text-muted-foreground">
              {costs.isError ? "Couldn't load the cost" : "Loading…"}
            </dd>
          </>
        ) : (
          <SandboxCostFacts cost={cost} />
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

function SandboxCostFacts(props: { readonly cost: SandboxCost }): ReactNode {
  const { cost } = props;
  const charged =
    cost.charged.computeMillicredits + cost.charged.storageMillicredits;
  return (
    <>
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

/** Counts the grants without listing destinations on the Overview. */
function SandboxSecretsSection(props: {
  readonly summary: SandboxSummary;
  readonly state: HostSandboxState | null;
  readonly frozen: boolean;
  readonly hostState: HostHealthState;
  readonly teamOwned: boolean;
}): ReactNode {
  const { summary } = props;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const grants = useSandboxGrants(summary.environmentId, summary.hostId);
  const routes = sandboxHostVouches(props.hostState) ? summary.routes : null;
  const readiness = sandboxSecretsReadiness(
    props.state,
    props.frozen,
    summary,
    props.hostState,
  );
  const grantsSummary = grants.data ?? null;
  if (summary.phase === null && grantsSummary === null) return null;
  const line =
    grantsSummary === null
      ? null
      : sandboxSecretsSummary(grantsSummary, routes, readiness?.tone ?? null);
  const configurationId = props.teamOwned
    ? summary.environmentId
    : PERSONAL_CONFIGURATION_ID;
  return (
    <>
      <SandboxSecretsSummaryRow
        line={line}
        failed={grantsSummary === null && grants.isError}
        configurationId={configurationId}
        refetching={grants.isFetching}
        onRetry={() => void grants.refetch()}
        onSeeWhy={() => setDetailsOpen(true)}
      />
      {grantsSummary === null && readiness === null ? null : (
        <SandboxSecretsDetails
          summary={grantsSummary}
          routes={routes}
          readiness={readiness}
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
        />
      )}
      {summary.phase === null ? null : (
        <SandboxNetworkEvents
          key={summary.hostId}
          hostId={summary.hostId}
          awake={props.state === "awake" && !props.frozen}
          routeAddresses={sandboxRouteAddresses(grants.data ?? null)}
        />
      )}
    </>
  );
}

function SandboxSecretsSummaryRow(props: {
  readonly line: SandboxSecretsLine | null;
  readonly failed: boolean;
  readonly configurationId: string | null;
  readonly refetching: boolean;
  readonly onRetry: () => void;
  readonly onSeeWhy: () => void;
}): ReactNode {
  const { line, configurationId } = props;
  return (
    <>
      {" "}
      {line === null && !props.failed ? null : (
        <div
          className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3 text-ui-xs"
          data-testid="sandbox-card-secrets"
        >
          <span>{line?.label ?? "Couldn't load this sandbox's secrets"}</span>
          {line?.notWorking === true ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={props.onSeeWhy}
            >
              See why
            </Button>
          ) : null}
          {configurationId === null ? null : (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() =>
                openEnvironmentPage({ configurationId, pageId: "secrets" })
              }
            >
              Manage
            </Button>
          )}
          {props.failed ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={props.refetching}
              onClick={props.onRetry}
            >
              Retry
            </Button>
          ) : null}
        </div>
      )}
    </>
  );
}

/** Keeps sandbox-specific grant facts out of the summary. */
function SandboxSecretsDetails(props: {
  readonly summary: SandboxGrantsSummary | null;
  readonly readiness: SandboxSecretsReadiness | null;
  readonly routes: SandboxSummary["routes"];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const views =
    props.summary === null
      ? []
      : sandboxGrantViews(props.summary, props.routes);
  const github = props.summary?.github ?? null;
  return (
    <details
      open={props.open}
      onToggle={(event) => props.onOpenChange(event.currentTarget.open)}
      data-testid="sandbox-card-secret-details"
      className="text-ui-xs"
    >
      <summary className="cursor-pointer">Details</summary>
      <div className="mt-3 flex flex-col gap-2">
        {props.summary !== null && sandboxHasBrokeredGrant(props.summary) ? (
          <p
            className="text-muted-foreground"
            data-testid="sandbox-card-stand-in"
          >
            {SANDBOX_STAND_IN_CLAUSE}
          </p>
        ) : null}
        {props.readiness === null ? null : (
          <p
            data-testid="sandbox-card-secrets-readiness"
            data-tone={props.readiness.tone}
            className="wrap-anywhere text-muted-foreground"
          >
            {props.readiness.text}
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {views.map((view) => (
            <SandboxGrantRow key={view.secretName} view={view} />
          ))}
        </ul>
        {github === null ? null : (
          <p
            className="wrap-anywhere text-muted-foreground"
            data-testid="sandbox-card-github"
          >
            {sandboxGitHubLine(github)}
          </p>
        )}
      </div>
    </details>
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
        <span className="text-muted-foreground">
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

function SandboxNetworkEvents(props: {
  readonly hostId: string;
  readonly awake: boolean;
  readonly routeAddresses: ReadonlyMap<string, string>;
}): ReactNode {
  const events = useSandboxEgressEvents(props.awake ? props.hostId : null);
  const lines = sandboxCardEgressEventLines(events);
  const blocked = lines.filter((line) => line.tone === "refused").length;
  if (lines.length === 0) return null;
  return (
    <details
      className="border-t border-border/50 pt-3 text-ui-xs"
      data-testid="sandbox-card-egress-events"
    >
      <summary className="cursor-pointer">
        {blocked === 0
          ? "Recent network events"
          : `${blocked} recent blocked ${blocked === 1 ? "request" : "requests"}`}
        {" · See events"}
      </summary>
      <ul className="mt-3 flex flex-col gap-2">
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
    </details>
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
        "rounded-md border px-2 py-1.5 mb-3 text-ui-xs leading-snug wrap-anywhere",
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
function SandboxRepairAction(props: {
  readonly hostId: string;
  readonly guestConfigured: boolean | null | undefined;
}): ReactNode {
  const supported = useHostSupportsMethod(
    props.hostId,
    "host.sandbox.repairGuestConfiguration",
  );
  const repair = useSandboxRepairGuestConfiguration();
  const list = useSandboxList();
  if (!supported || props.guestConfigured !== false) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="default"
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
    </div>
  );
}

/** Shares the sandbox verbs with the host's single menu; dialogs outlive it. */
export function SandboxHeaderActions(props: {
  readonly hostName: string;
  readonly sandbox: HostScopeSandbox;
  readonly onDestroyed: (() => void) | null;
  readonly renderActions:
    | ((primary: ReactNode, menuItems: ReactNode) => ReactNode)
    | null;
}): ReactNode {
  const summary = props.sandbox.summary;
  if (summary === null) return props.renderActions?.(null, null) ?? null;
  return (
    <SandboxHeaderActionSet
      summary={summary}
      sandbox={props.sandbox}
      onDestroyed={props.onDestroyed}
      renderActions={props.renderActions}
      hostName={props.hostName}
    />
  );
}

function SandboxHeaderActionSet(props: {
  readonly summary: SandboxSummary;
  readonly sandbox: HostScopeSandbox;
  readonly hostName: string;
  readonly onDestroyed: (() => void) | null;
  readonly renderActions:
    | ((primary: ReactNode, menuItems: ReactNode) => ReactNode)
    | null;
}): ReactNode {
  const { summary, sandbox } = props;
  const actions = sandboxCardActions(
    sandbox.state,
    sandbox.frozen,
    summary.kind,
    sandbox.teamOwned,
  );
  const operation = sandboxOperationShown(
    useSandboxOperation(summary.id),
    (action) => actions.includes(action),
  );
  const pendingVerb = operation?.kind === "pending" ? operation.verb : null;
  const verb = useSandboxVerb(summary.id);
  const destroy = useSandboxDestroy(summary);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const repairSupported = useHostSupportsMethod(
    summary.hostId,
    "host.sandbox.repairGuestConfiguration",
  );
  const repair = sandboxHeaderNeedsRepair(
    summary,
    sandbox.state,
    sandbox.frozen,
    repairSupported,
  );
  const primary = repair ? null : sandboxHeaderPrimaryAction(actions);
  const run = (action: SandboxCardAction): void => {
    if (action === "destroy") {
      setConfirmOpen(true);
      return;
    }
    verb.mutate(action, {
      onSuccess: (outcome) =>
        toastSandboxVerbOutcome(action, outcome, summary.displayName),
    });
  };
  let primaryControl: ReactNode = null;
  if (repair)
    primaryControl = (
      <SandboxRepairAction
        hostId={summary.hostId}
        guestConfigured={summary.guestConfigured}
      />
    );
  else if (primary !== null)
    primaryControl = (
      <Button
        type="button"
        size="sm"
        disabled={pendingVerb !== null}
        data-testid={`sandbox-card-${primary}`}
        onClick={() => run(primary)}
      >
        {pendingVerb === primary ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        {pendingVerb === primary ? (
          <span role="status">{sandboxVerbPendingLine(primary)}</span>
        ) : (
          SANDBOX_CARD_ACTION_LABEL[primary]
        )}
      </Button>
    );
  if (
    actions.length === 0 &&
    operation === null &&
    !repair &&
    props.renderActions === null
  )
    return null;
  const menuItems = actions
    .filter((action) => action !== primary)
    .map((action) => (
      <DropdownMenuItem
        key={action}
        variant={action === "destroy" ? "destructive" : "default"}
        disabled={
          action === "destroy"
            ? pendingVerb === "destroy"
            : pendingVerb !== null
        }
        data-testid={`sandbox-card-${action}`}
        onSelect={() => run(action)}
      >
        {SANDBOX_CARD_ACTION_LABEL[action]}
      </DropdownMenuItem>
    ));
  return (
    <>
      {props.renderActions === null ? (
        <div className="flex max-w-full flex-wrap items-center gap-2">
          {primaryControl}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`More actions for ${props.hostName}`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{menuItems}</DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        props.renderActions(primaryControl, menuItems)
      )}
      {pendingVerb !== null && pendingVerb !== primary ? (
        <span role="status" className="text-ui-xs">
          {sandboxVerbPendingLine(pendingVerb)}
        </span>
      ) : null}
      <SandboxOperationFailure
        sandboxId={summary.id}
        name={summary.displayName}
        hostId={summary.hostId}
        operation={operation}
        busy={pendingVerb !== null}
        onRetry={(pressed) => {
          if (pressed === "destroy")
            destroy.mutate(
              operation?.kind === "failed"
                ? operation.destroyRequest
                : undefined,
              {
                onSuccess: (gone) => {
                  if (gone) props.onDestroyed?.();
                },
              },
            );
          else
            verb.mutate(pressed, {
              onSuccess: (outcome) =>
                toastSandboxVerbOutcome(pressed, outcome, summary.displayName),
            });
        }}
      />
      <SandboxDestroyDialog
        sandbox={summary}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onDestroyed={props.onDestroyed}
      />
    </>
  );
}

function formatShape(cpus: number, memoryMb: number, diskMb: number): string {
  const vcpu = `${cpus} vCPU`;
  return diskMb > 0
    ? `${vcpu} · ${formatMemory(memoryMb)} memory · ${formatMemory(diskMb)} disk`
    : `${vcpu} · ${formatMemory(memoryMb)} memory`;
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
