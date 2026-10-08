import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type {
  SandboxCost,
  SandboxHourlyPrice,
  SandboxLifecycleVerb,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { isSandboxFrozenInEffect } from "@traycer-clients/shared/host-client/sandbox-control";
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
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SandboxRunwayWarningLine } from "@/components/hosts/sandbox-balance-banner";
import {
  formatSandboxDay,
  SANDBOX_CARD_ACTION_LABEL,
  sandboxCardActions,
  sandboxGuestConfigFailure,
  sandboxIdleLine,
  sandboxStateLine,
  sandboxSuspendKeepsLine,
  type SandboxCardAction,
} from "@/components/hosts/sandbox-card-model";
import type { HostScopeSandbox } from "@/components/settings/host-scope/host-scope-model";
import { sandboxStateWord } from "@/components/settings/host-scope/host-option-model";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useRefreshSandboxCosts } from "@/hooks/sandboxes/use-refresh-sandbox-costs";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useSandboxCosts } from "@/hooks/sandboxes/use-sandbox-costs-query";
import { useSandboxDestroy } from "@/hooks/sandboxes/use-sandbox-destroy-mutation";
import { useSandboxRunwayWarning } from "@/hooks/sandboxes/use-sandbox-runway-warning";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import { formatRelativeTimestamp, useSampledNow } from "@/lib/relative-time";
import {
  formatRunway,
  sandboxBalanceMc,
  sandboxCostTodayMc,
  sandboxRunwayMinutes,
} from "@/lib/sandboxes/sandbox-balance";
import { formatCredits, formatMemory } from "@/lib/sandboxes/sandbox-pricing";

/**
 * The card a sandbox host shows above its identity card in Settings: its
 * state with that state's copy and actions (`sandbox-card-model.ts`), shape,
 * region, rate, idle rule and last activity, the guest's configuration
 * failure when the heartbeat reports one, the cost view, and the balance.
 *
 * A frozen sandbox (out of credits) shows the frozen line with its destroy
 * date and the balance, and offers only destroy, behind a typed
 * confirmation.
 */
export function SandboxCard(props: {
  readonly hostName: string;
  readonly sandbox: HostScopeSandbox;
}): ReactNode {
  const { summary } = props.sandbox;
  const state = props.sandbox.state ?? summary?.state ?? null;
  const frozen = isSandboxFrozenInEffect(
    state,
    props.sandbox.frozen || summary?.frozen === true,
  );
  const word = sandboxStateWord({ ...props.sandbox, state, frozen });
  const actions = summary === null ? [] : sandboxCardActions(state, frozen);
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
          {sandboxStateLine(state, frozen, summary)}
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
          <p className="text-ui-xs text-muted-foreground">
            Loading this sandbox&apos;s details…
          </p>
        ) : (
          <>
            <SandboxFacts summary={summary} />
            <SandboxGuestConfigFailure summary={summary} />
            <SandboxCostView sandboxId={summary.id} frozen={frozen} />
          </>
        )}
        <SandboxSecretsSummarySlot />
      </CardContent>
      {summary !== null && actions.length > 0 ? (
        <CardFooter className="flex flex-wrap gap-2">
          <SandboxActions summary={summary} actions={actions} frozen={frozen} />
        </CardFooter>
      ) : null}
    </Card>
  );
}

function SandboxFacts(props: { readonly summary: SandboxSummary }): ReactNode {
  const { summary } = props;
  const now = useSampledNow();
  const provider =
    useSandboxCatalogue(true).data?.providers.find(
      (p) => p.provider === summary.provider,
    ) ?? null;
  const keeps =
    provider === null
      ? null
      : sandboxSuspendKeepsLine(provider.suspendFidelity);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-xs">
      <dt className="text-muted-foreground">Size</dt>
      <dd data-testid="sandbox-card-shape">
        {formatShape(summary.cpus, summary.memoryMb, summary.diskMb)}
      </dd>
      <dt className="text-muted-foreground">Region</dt>
      <dd data-testid="sandbox-card-region">{summary.region}</dd>
      <dt className="text-muted-foreground">Rate</dt>
      <dd data-testid="sandbox-card-rate">
        {formatRate(summary.priceMcPerHour)}
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
    </dl>
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
 * account's awake burn, and the two-hour and thirty-minute warnings.
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
          <SandboxCostFacts cost={cost} now={now} />
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
          : `${formatCredits(cost.currentRateMillicreditsPerHour)} credits/hour`}
      </dd>
      <dt className="text-muted-foreground">Today</dt>
      <dd data-testid="sandbox-card-cost-today">
        {`${formatCredits(sandboxCostTodayMc(cost, props.now))} credits`}
      </dd>
      <dt className="text-muted-foreground">Charged</dt>
      <dd data-testid="sandbox-card-cost-charged">
        {`${formatCredits(charged)} credits since ${formatSandboxDay(cost.charged.sinceCreatedAt)} (${formatCredits(cost.charged.computeMillicredits)} compute · ${formatCredits(cost.charged.storageMillicredits)} storage)`}
        {cost.pendingMillicredits > 0
          ? ` · ${formatCredits(cost.pendingMillicredits)} pending`
          : null}
      </dd>
    </>
  );
}

/**
 * The named slot the secrets summary (the secrets this sandbox may use, their
 * destinations and their mode) renders into. Empty in this release; the
 * secrets track fills it, here and nowhere else on the card.
 */
function SandboxSecretsSummarySlot(): ReactNode {
  return null;
}

const VERB_DONE_TOAST: Record<SandboxLifecycleVerb, string> = {
  suspend: "Suspended",
  resume: "Resumed",
  stop: "Stopped",
  start: "Started",
};

/** A `202`: the server's deadline passed with the row still moving. */
const VERB_MOVING_TOAST: Record<SandboxLifecycleVerb, string> = {
  suspend: "Suspending",
  resume: "Resuming",
  stop: "Stopping",
  start: "Starting",
};

function SandboxActions(props: {
  readonly summary: SandboxSummary;
  readonly actions: readonly SandboxCardAction[];
  readonly frozen: boolean;
}): ReactNode {
  const { summary } = props;
  const verb = useSandboxVerb(summary.id);
  const pendingVerb = verb.isPending ? verb.variables : null;
  return (
    <>
      {props.actions.map((action) =>
        action === "destroy" ? (
          // Not gated on a pending verb: a verb can wait out the server's
          // 300 s deadline, and destroy is the way out of one that will not
          // land (the server refuses it only while the row is mid-transition).
          <SandboxDestroyAction
            key={action}
            sandboxId={summary.id}
            name={summary.displayName}
            typedConfirmation={props.frozen}
          />
        ) : (
          <Button
            key={action}
            type="button"
            variant={
              action === "resume" || action === "start" ? "default" : "outline"
            }
            size="sm"
            disabled={verb.isPending}
            data-testid={`sandbox-card-${action}`}
            onClick={() => {
              verb.mutate(action, {
                onSuccess: (outcome) => {
                  if (outcome === "settled") {
                    toast.success(
                      `${VERB_DONE_TOAST[action]} ${summary.displayName}`,
                    );
                  } else if (outcome === "moving") {
                    toast.info(
                      `${VERB_MOVING_TOAST[action]} ${summary.displayName}…`,
                    );
                  }
                },
              });
            }}
          >
            {pendingVerb === action ? (
              <AgentSpinningDots
                className={undefined}
                testId={`sandbox-card-${action}-spinner`}
                variant={undefined}
              />
            ) : null}
            {SANDBOX_CARD_ACTION_LABEL[action]}
          </Button>
        ),
      )}
    </>
  );
}

function SandboxDestroyAction(props: {
  readonly sandboxId: string;
  readonly name: string;
  /** A frozen sandbox asks for its name to be typed (core flows, flow 5). */
  readonly typedConfirmation: boolean;
}): ReactNode {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const destroy = useSandboxDestroy(props.sandboxId);
  const mismatch = props.typedConfirmation && typed.trim() !== props.name;
  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={destroy.isPending}
        data-testid="sandbox-card-destroy"
        onClick={() => {
          setTyped("");
          setConfirmOpen(true);
        }}
      >
        {destroy.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId="sandbox-card-destroy-spinner"
            variant={undefined}
          />
        ) : null}
        Destroy
      </Button>
      <ConfirmDestructiveDialog
        blockedReason={typedConfirmationReason(
          props.typedConfirmation,
          typed,
          props.name,
        )}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Destroy ${props.name}?`}
        description={`${props.name} and its disk are deleted and can't be recovered. Code on a sandbox is not synced anywhere, so copy off anything you want to keep first.`}
        cascadeSummary={null}
        actionLabel="Destroy sandbox"
        isPending={destroy.isPending}
        onConfirm={() => {
          if (mismatch) return;
          destroy.mutate(undefined, {
            onSuccess: (gone) => {
              setConfirmOpen(false);
              if (gone) {
                toast.success(`Destroyed ${props.name}`);
              } else {
                toast.info(`Destroying ${props.name}…`);
              }
            },
          });
        }}
      >
        {props.typedConfirmation ? (
          <div className="flex flex-col gap-1.5 px-5 pb-4">
            <Label htmlFor={inputId}>
              This sandbox is frozen. Type its name to confirm.
            </Label>
            <Input
              id={inputId}
              value={typed}
              autoComplete="off"
              placeholder={props.name}
              data-testid="sandbox-card-destroy-typed"
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        ) : null}
      </ConfirmDestructiveDialog>
    </>
  );
}

/**
 * What the typed confirmation still needs: `null` once the name matches (or
 * when none is asked for), an empty reason while nothing is typed (confirm
 * disabled, no sentence), and the instruction once something is typed.
 */
function typedConfirmationReason(
  required: boolean,
  typed: string,
  name: string,
): string | null {
  if (!required || typed.trim() === name) return null;
  return typed.length === 0 ? "" : `Type ${name} below to destroy it.`;
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
  return `${formatCredits(price.awakeMc)} credits/hour awake · ${formatCredits(price.suspendedMc)} suspended · ${formatCredits(price.stoppedMc)} stopped`;
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
  const balance = `${formatCredits(balanceMc)} credits`;
  if (frozen || burnMcPerHour === null) return balance;
  const minutes = sandboxRunwayMinutes(balanceMc, burnMcPerHour);
  return minutes === null
    ? balance
    : `${balance}, about ${formatRunway(minutes)} at your current burn`;
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}
