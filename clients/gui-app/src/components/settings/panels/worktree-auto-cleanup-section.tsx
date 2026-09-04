import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight, History, Info } from "lucide-react";
import type { WorktreeAutoCleanupPolicyState } from "@traycer/protocol/host/worktree-auto-cleanup-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { SETTINGS_ROW_STACK } from "@/components/settings/settings-row-layout";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  useSettingsDensity,
  type SettingsDensity,
} from "@/providers/settings-density-context";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  resolveAutoCleanupGate,
  type AutoCleanupGate,
} from "@/components/settings/panels/worktree-auto-cleanup-gate";
import {
  isAutoCleanupRevisionConflict,
  useWorktreeAutoCleanupPolicy,
  useWorktreeSetAutoCleanupPolicy,
} from "@/hooks/worktree/use-worktree-auto-cleanup";
import {
  AUTO_CLEANUP_DAY_PRESETS,
  AUTO_CLEANUP_PAUSED_COPY,
  autoCleanupDaysError,
} from "@/components/settings/panels/worktree-auto-cleanup-copy";
import {
  formatResetCountdown,
  useRelativeTimestamp,
  useSampledNow,
} from "@/lib/relative-time";

/**
 * Settings ▸ Worktrees ▸ Automatic cleanup — the per-HOST opt-in.
 *
 * Default off, and the toggle is the whole opt-in: nothing here schedules,
 * simulates or retries cleanup client-side. A host that does not advertise the
 * capability renders an explanation and no controls rather than a local
 * fallback, because deletion authority is the host's alone.
 *
 * Sits ABOVE `HostScopeGate` (the inventory owns that), so it makes the two
 * checks the gate would otherwise make for it — scope usability and
 * reachability — before mounting any host read.
 */
export function WorktreeAutoCleanupSection(props: {
  readonly scope: HostScope;
  readonly onOpenHistory: () => void;
}): ReactNode {
  const { scope, onOpenHistory } = props;
  const hostId = scope.hostId;
  const reachability = useHostReachability(hostId ?? "");
  const supported = useHostMethodSupport(
    hostId,
    "worktree.getAutoCleanupPolicy",
  );
  const gate = resolveAutoCleanupGate({
    hostId,
    scopeUsable: isHostScopeUsable(scope.status),
    reachabilityStatus: reachability.status,
    hasClient: scope.client !== null,
    supported,
  });

  if (gate === "absent") return null;
  if (gate !== "ready") {
    return <AutoCleanupNotice gate={gate} hostLabel={scope.hostLabel} />;
  }
  return (
    <AutoCleanupControls
      client={scope.client}
      hostLabel={scope.hostLabel}
      onOpenHistory={onOpenHistory}
    />
  );
}

function AutoCleanupNotice(props: {
  readonly gate: Exclude<AutoCleanupGate, "absent" | "ready">;
  readonly hostLabel: string;
}): ReactNode {
  return (
    <div
      className="flex w-full items-start gap-2 rounded-lg border border-border/60 bg-card/40 px-3.5 py-2.5 text-ui-xs text-muted-foreground"
      data-testid="worktree-auto-cleanup-notice"
      data-gate={props.gate}
      role="status"
    >
      <Info className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="max-w-[68ch]">
        {props.gate === "checking" ? (
          <>Checking whether {props.hostLabel} can run automatic cleanup…</>
        ) : null}
        {props.gate === "offline" ? (
          <>
            Automatic cleanup settings are unavailable while {props.hostLabel}{" "}
            is offline. Cleanup runs on that host, so it resumes on its own when
            the host is running again.
          </>
        ) : null}
        {props.gate === "unsupported" ? (
          <>
            {props.hostLabel} is running a version without automatic cleanup.
            Update the host to turn it on — nothing is scheduled from here.
          </>
        ) : null}
      </span>
    </div>
  );
}

const SUMMARY_PADDING: Record<SettingsDensity, string> = {
  compact: "gap-2.5 px-3 py-2",
  relaxed: "gap-3.5 px-3.5 py-2.5",
};

const SECONDARY_PADDING: Record<SettingsDensity, string> = {
  compact: "px-3 py-1.5",
  relaxed: "px-3.5 py-2",
};

const DISCLOSURE_PADDING: Record<SettingsDensity, string> = {
  compact: "px-3 py-2",
  relaxed: "px-3.5 py-2.5",
};

/**
 * The card is a two-line SUMMARY, and everything that only matters while
 * someone is changing the policy lives behind a disclosure.
 *
 * The reason is the card's neighbour: it sits directly above the worktree
 * inventory in a panel of fixed height, so every row it spends
 * unconditionally is a worktree the list below cannot show. The threshold
 * presets and the safety explanation are read while deciding and then never
 * again, while the switch, the schedule and the history entry point are what
 * the card is consulted for — so those stay on screen and the rest folds away.
 */
function AutoCleanupControls(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostLabel: string;
  readonly onOpenHistory: () => void;
}): ReactNode {
  const { client, onOpenHistory } = props;
  const policyQuery = useWorktreeAutoCleanupPolicy(client, true);
  const setPolicy = useWorktreeSetAutoCleanupPolicy(client);
  const policy = policyQuery.data ?? null;
  const density = useSettingsDensity();
  // Component-local and never persisted. The collapsed summary is this card's
  // resting shape on every mount, so re-entering Settings or switching hosts
  // starts closed rather than restoring someone's last visit to the threshold.
  const [configuring, setConfiguring] = useState(false);
  const enabled = policy !== null && policy.enabled;
  // A policy that deletes nothing has nothing to configure, so a disclosure
  // left open by an earlier visit closes with the switch rather than
  // outliving the thing it edits.
  const expanded = enabled && configuring;

  return (
    <div
      className="w-full overflow-hidden rounded-lg border border-border/60 bg-card/40"
      data-testid="worktree-auto-cleanup-section"
    >
      <Collapsible open={expanded} onOpenChange={setConfiguring}>
        <AutoCleanupSummaryRow
          policy={policy}
          density={density}
          busy={setPolicy.isPending}
          expanded={expanded}
          onSetEnabled={(next) => {
            if (policy === null) return;
            // Turning the policy off closes the editor with it, and turning it
            // back on must NOT re-open it: the summary is the resting shape,
            // not a state the toggle can talk the card out of.
            if (!next) setConfiguring(false);
            setPolicy.mutate({
              enabled: next,
              inactivityDays: policy.inactivityDays,
              expectedRevision: policy.revision,
            });
          }}
        />
        <CollapsibleContent>
          {policy !== null && policy.enabled ? (
            <AutoCleanupThresholdEditor
              policy={policy}
              density={density}
              busy={setPolicy.isPending}
              onCommitDays={(days) => {
                setPolicy.mutate({
                  enabled: policy.enabled,
                  inactivityDays: days,
                  expectedRevision: policy.revision,
                });
              }}
            />
          ) : null}
        </CollapsibleContent>
      </Collapsible>
      <AutoCleanupStatusRows
        density={density}
        pending={policyQuery.isPending}
        readError={policyQuery.isError ? policyQuery.error.message : null}
        conflicted={isAutoCleanupRevisionConflict(setPolicy.error)}
      />
      {policy !== null && policy.pausedReason !== null ? (
        <p
          role="status"
          data-testid="worktree-auto-cleanup-paused"
          className={cn(
            "border-t border-border/40 text-ui-xs text-amber-700 dark:text-amber-300",
            SECONDARY_PADDING[density],
          )}
        >
          {AUTO_CLEANUP_PAUSED_COPY[policy.pausedReason]}
        </p>
      ) : null}
      {enabled ? (
        <AutoCleanupScheduleRow
          policy={policy}
          density={density}
          onOpenHistory={onOpenHistory}
        />
      ) : null}
    </div>
  );
}

/**
 * Line one: what the policy currently does, the disclosure, and the switch.
 *
 * The disclosure trigger is its OWN button rather than the whole row, because
 * the row's trailing edge holds the switch — a row-wide trigger would nest an
 * interactive control inside a button and make the one control that must stay
 * a single tab stop unreachable.
 */
function AutoCleanupSummaryRow(props: {
  readonly policy: WorktreeAutoCleanupPolicyState | null;
  readonly density: SettingsDensity;
  readonly busy: boolean;
  readonly expanded: boolean;
  readonly onSetEnabled: (next: boolean) => void;
}): ReactNode {
  const { policy, density, busy, expanded, onSetEnabled } = props;
  const enabled = policy !== null && policy.enabled;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center",
        SUMMARY_PADDING[density],
        SETTINGS_ROW_STACK.container,
      )}
    >
      <div className={cn("min-w-0 flex-1", SETTINGS_ROW_STACK.label)}>
        <p
          className="text-ui-sm text-foreground"
          data-testid="worktree-auto-cleanup-summary"
        >
          <span className="font-medium">Automatic cleanup</span>
          {policy === null ? null : (
            <span className="text-muted-foreground">
              {enabled
                ? ` · On · after ${autoCleanupDaysLabel(policy.inactivityDays)}`
                : " · Off"}
            </span>
          )}
        </p>
        {policy !== null && !enabled ? (
          <p className="mt-0.5 text-ui-xs text-muted-foreground">
            Nothing is deleted automatically.
          </p>
        ) : null}
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-2",
          SETTINGS_ROW_STACK.control,
        )}
      >
        {busy ? (
          <AgentSpinningDots
            className="text-muted-foreground"
            testId="worktree-auto-cleanup-saving"
            variant={undefined}
          />
        ) : null}
        {enabled ? (
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="group text-muted-foreground"
              aria-label={
                expanded
                  ? "Collapse automatic cleanup settings"
                  : "Configure automatic cleanup"
              }
            >
              <span>{expanded ? "Collapse" : "Configure"}</span>
              <ChevronRight
                className="transition-transform group-data-[state=open]:rotate-90"
                aria-hidden
              />
            </Button>
          </CollapsibleTrigger>
        ) : null}
        <Switch
          aria-label="Automatic cleanup"
          checked={enabled}
          disabled={policy === null || busy}
          onCheckedChange={onSetEnabled}
        />
      </div>
    </div>
  );
}

/** "1 day" / "30 days" — the summary reads as a sentence, so it agrees. */
function autoCleanupDaysLabel(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/** Loading, the read's failure, and the write's one non-toasted rejection. */
function AutoCleanupStatusRows(props: {
  readonly density: SettingsDensity;
  readonly pending: boolean;
  readonly readError: string | null;
  readonly conflicted: boolean;
}): ReactNode {
  const { density, pending, readError, conflicted } = props;
  return (
    <>
      {pending ? (
        <p
          className={cn(
            "border-t border-border/40 text-ui-xs text-muted-foreground",
            SECONDARY_PADDING[density],
          )}
        >
          Loading automatic cleanup settings…
        </p>
      ) : null}
      {readError !== null ? (
        <p
          role="alert"
          className={cn(
            "border-t border-border/40 text-ui-xs text-destructive",
            SECONDARY_PADDING[density],
          )}
        >
          {readError}
        </p>
      ) : null}
      {conflicted ? (
        <p
          role="alert"
          data-testid="worktree-auto-cleanup-conflict"
          className={cn(
            "border-t border-border/40 text-ui-xs text-amber-700 dark:text-amber-300",
            SECONDARY_PADDING[density],
          )}
        >
          Automatic cleanup was changed somewhere else. The current setting is
          shown above — apply your change again if you still want it.
        </p>
      ) : null}
    </>
  );
}

/**
 * Line two: when the host last looked and when it looks next, plus the way
 * into the record of what it did.
 *
 * Both stay OUTSIDE the disclosure. They are the two things a person opens
 * this card to check without changing anything, and a schedule that has to be
 * unfolded to be read is a schedule nobody reads.
 */
function AutoCleanupScheduleRow(props: {
  readonly policy: WorktreeAutoCleanupPolicyState;
  readonly density: SettingsDensity;
  readonly onOpenHistory: () => void;
}): ReactNode {
  const { policy, density, onOpenHistory } = props;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 border-t border-border/40",
        SECONDARY_PADDING[density],
      )}
    >
      <AutoCleanupSchedule policy={policy} />
      {/* History records AUTOMATIC runs only - manual deletions never appear
          in it - so the button belongs to the enabled policy and nowhere
          else. With cleanup off, a button here read as the place manual
          deletions should show up. The rows themselves persist (retention
          is 200 runs / 90 days), so re-enabling brings the record back. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={onOpenHistory}
      >
        <History className="size-4" />
        <span>Automatic cleanup history</span>
      </Button>
    </div>
  );
}

/**
 * Last / next evaluation.
 *
 * `nextEvaluationAt` is `null` while paused or disabled, and that is a REAL
 * state rather than an unknown one — so it reads as paused instead of as a
 * missing timestamp. Paused time does not advance `lastEvaluatedAt` either,
 * which is exactly why the pause line above exists: a stale "last checked"
 * must never be the only evidence that nothing is happening.
 *
 * Deliberately NOT a live region: it repaints every minute on a shared clock,
 * and a countdown that announces itself would talk over everything else on
 * the page for as long as Settings is open.
 */
function AutoCleanupSchedule(props: {
  readonly policy: WorktreeAutoCleanupPolicyState;
}): ReactNode {
  const { policy } = props;
  return (
    <span
      className="min-w-0 text-ui-xs text-muted-foreground"
      data-testid="worktree-auto-cleanup-schedule"
    >
      {policy.lastEvaluatedAt === null ? (
        <>Last checked: not yet</>
      ) : (
        <>
          Last checked <AutoCleanupWhen at={policy.lastEvaluatedAt} />
        </>
      )}
      {" · "}
      {policy.nextEvaluationAt === null ? (
        <>Next check: paused</>
      ) : (
        <>
          next check <AutoCleanupNextCheck at={policy.nextEvaluationAt} />
        </>
      )}
    </span>
  );
}

/** Leaf, so the shared 60s clock repaints the label and not the whole card. */
function AutoCleanupWhen(props: { readonly at: number }): ReactNode {
  const label = useRelativeTimestamp(props.at);
  return <>{label}</>;
}

/**
 * A deadline closer than this reads as "under a minute" rather than as a
 * seconds count. The shared clock ticks once a minute, so "in 28s" would sit
 * frozen past its own deadline; a phrase that stays true for the whole
 * minute is honest at that granularity, and a one-second timer for a row
 * nobody watches would not be.
 */
const UNDER_A_MINUTE_MS = 60_000;

/**
 * The FUTURE leaf. `useRelativeTimestamp` is a past-tense formatter whose
 * negative-delta clamp renders any upcoming instant as "Just now" - which is
 * exactly what a freshly enabled policy showed for a check ~30s away. A time
 * that has already arrived (the scheduler picks the pass up on its next
 * cadence tick) reads as due rather than as a countdown of zero.
 */
function AutoCleanupNextCheck(props: { readonly at: number }): ReactNode {
  const sampled = useSampledNow();
  // The deadline-aligned wake. The shared clock samples once a minute, so
  // without this "in under a minute" would outlive the deadline by up to a
  // tick. Inside the last minute a one-shot timer fires exactly at `at`;
  // re-armed on every sample as well as on `at`, because the minute the
  // deadline enters is only known once a fresh sample says so. `arrivedAt`
  // needs no reset when `at` moves: a stale value is always below the new
  // deadline, and `max` with the live sample discards it.
  const [arrivedAt, setArrivedAt] = useState<number | null>(null);
  useEffect(() => {
    const remaining = props.at - Date.now();
    if (remaining <= 0 || remaining >= UNDER_A_MINUTE_MS) return undefined;
    const handle = window.setTimeout(() => {
      setArrivedAt(props.at);
    }, remaining);
    return () => {
      window.clearTimeout(handle);
    };
  }, [props.at, sampled]);
  const now = arrivedAt === null ? sampled : Math.max(sampled, arrivedAt);
  if (props.at <= now) return <>due now</>;
  if (props.at - now < UNDER_A_MINUTE_MS) return <>in under a minute</>;
  return <>in {formatResetCountdown(props.at, now)}</>;
}

/**
 * The disclosure's whole content: what cleanup actually does, then the
 * inactivity threshold — five presets plus a validated free value.
 *
 * The safety sentence lives HERE rather than on the collapsed row. It answers
 * "what am I turning on", which is a question asked while configuring; the
 * summary answers "what is it doing right now", and carrying both made the
 * card two lines taller for every reader who had already decided.
 *
 * Validation reads the HOST's `bounds` rather than a constant here, so a host
 * that moves them needs no client release — and the control can never offer a
 * value the host is about to refuse.
 */
function AutoCleanupThresholdEditor(props: {
  readonly policy: WorktreeAutoCleanupPolicyState;
  readonly density: SettingsDensity;
  readonly busy: boolean;
  readonly onCommitDays: (days: number) => void;
}): ReactNode {
  const { policy, density, busy, onCommitDays } = props;
  const errorId = useId();
  const [draft, setDraft] = useState(String(policy.inactivityDays));
  const [hasLocalEdit, setHasLocalEdit] = useState(false);
  // Adjusted during render (React's documented way to sync state off a
  // changing external value): a write landing elsewhere — another window, the
  // conflict re-read — reaches the field, but never mid-edit.
  const [error, setError] = useState<string | null>(null);
  if (!hasLocalEdit && draft !== String(policy.inactivityDays)) {
    setDraft(String(policy.inactivityDays));
    setError(null);
  }

  const commitDraft = useCallback(
    (value: string) => {
      const validationError = autoCleanupDaysError(value, policy.bounds);
      setError(validationError);
      if (validationError !== null) return;
      setHasLocalEdit(false);
      const days = Number(value.trim());
      if (days === policy.inactivityDays) return;
      onCommitDays(days);
    },
    [onCommitDays, policy.bounds, policy.inactivityDays],
  );

  return (
    <div
      className={cn("border-t border-border/40", DISCLOSURE_PADDING[density])}
    >
      <p className="max-w-[68ch] text-ui-xs text-pretty text-muted-foreground">
        Removes worktrees on this host that have been inactive and stay proven
        safe to delete. Age alone never makes one safe.
      </p>
      <div
        className={cn(
          "mt-2.5 flex flex-wrap items-center gap-3",
          SETTINGS_ROW_STACK.container,
        )}
      >
        <div className={cn("min-w-0 flex-1", SETTINGS_ROW_STACK.label)}>
          <span className="text-ui-sm font-medium text-foreground">
            Inactive for
          </span>
          <p className="mt-0.5 text-ui-xs text-muted-foreground">
            A worktree is only considered once it has been idle this long.
          </p>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-1.5 max-md:w-full">
          {AUTO_CLEANUP_DAY_PRESETS.map((days) => (
            <Button
              key={days}
              type="button"
              size="sm"
              variant={days === policy.inactivityDays ? "secondary" : "outline"}
              aria-pressed={days === policy.inactivityDays}
              disabled={busy}
              onClick={() => {
                setHasLocalEdit(false);
                setError(null);
                setDraft(String(days));
                if (days !== policy.inactivityDays) onCommitDays(days);
              }}
            >
              {days} days
            </Button>
          ))}
          <Input
            value={draft}
            inputMode="numeric"
            aria-label="Custom inactivity days"
            aria-invalid={error !== null}
            aria-describedby={error !== null ? errorId : undefined}
            disabled={busy}
            className="h-8 w-[min(30vw,5rem)] text-ui-sm max-md:min-w-0 max-md:flex-1"
            onChange={(event) => {
              setDraft(event.target.value);
              setHasLocalEdit(true);
              setError(null);
            }}
            onBlur={(event) => commitDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span className="text-ui-xs text-muted-foreground">days</span>
        </div>
      </div>
      {error !== null ? (
        <p
          id={errorId}
          role="alert"
          className="mt-1.5 text-ui-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
