import { useCallback, useId, useState, type ReactNode } from "react";
import { History, Info } from "lucide-react";
import type { WorktreeAutoCleanupPolicyState } from "@traycer/protocol/host/worktree-auto-cleanup-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { SETTINGS_ROW_STACK } from "@/components/settings/settings-row-layout";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
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

function AutoCleanupControls(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostLabel: string;
  readonly onOpenHistory: () => void;
}): ReactNode {
  const { client, onOpenHistory } = props;
  const policyQuery = useWorktreeAutoCleanupPolicy(client, true);
  const setPolicy = useWorktreeSetAutoCleanupPolicy(client);
  const policy = policyQuery.data ?? null;

  return (
    <div
      className="w-full overflow-hidden rounded-lg border border-border/60 bg-card/40"
      data-testid="worktree-auto-cleanup-section"
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-3.5 px-3.5 py-2.5",
          SETTINGS_ROW_STACK.container,
        )}
      >
        <div className={cn("min-w-0 flex-1", SETTINGS_ROW_STACK.label)}>
          <span className="text-ui-sm font-medium text-foreground">
            Automatic cleanup
          </span>
          <p className="mt-0.5 text-ui-xs text-muted-foreground">
            Removes worktrees on this host that have been inactive and stay
            proven safe to delete. Age alone never makes one safe.
          </p>
        </div>
        <div
          className={cn(
            "flex shrink-0 items-center gap-2",
            SETTINGS_ROW_STACK.control,
          )}
        >
          {setPolicy.isPending ? (
            <AgentSpinningDots
              className="text-muted-foreground"
              testId="worktree-auto-cleanup-saving"
              variant={undefined}
            />
          ) : null}
          <Switch
            aria-label="Automatic cleanup"
            checked={policy?.enabled ?? false}
            disabled={policy === null || setPolicy.isPending}
            onCheckedChange={(next) => {
              if (policy === null) return;
              setPolicy.mutate({
                enabled: next,
                inactivityDays: policy.inactivityDays,
                expectedRevision: policy.revision,
              });
            }}
          />
        </div>
      </div>
      {policyQuery.isPending ? (
        <p className="border-t border-border/40 px-3.5 py-2 text-ui-xs text-muted-foreground">
          Loading automatic cleanup settings…
        </p>
      ) : null}
      {policyQuery.isError ? (
        <p
          role="alert"
          className="border-t border-border/40 px-3.5 py-2 text-ui-xs text-destructive"
        >
          {policyQuery.error.message}
        </p>
      ) : null}
      {isAutoCleanupRevisionConflict(setPolicy.error) ? (
        <p
          role="alert"
          data-testid="worktree-auto-cleanup-conflict"
          className="border-t border-border/40 px-3.5 py-2 text-ui-xs text-amber-700 dark:text-amber-300"
        >
          Automatic cleanup was changed somewhere else. The current setting is
          shown above — apply your change again if you still want it.
        </p>
      ) : null}
      {policy !== null && policy.enabled ? (
        <AutoCleanupThresholdRow
          policy={policy}
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
      {policy !== null && policy.pausedReason !== null ? (
        <p
          role="status"
          data-testid="worktree-auto-cleanup-paused"
          className="border-t border-border/40 px-3.5 py-2 text-ui-xs text-amber-700 dark:text-amber-300"
        >
          {AUTO_CLEANUP_PAUSED_COPY[policy.pausedReason]}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-3.5 py-2">
        {policy !== null && policy.enabled ? (
          <AutoCleanupSchedule policy={policy} />
        ) : (
          <span className="text-ui-xs text-muted-foreground">
            Cleanup is off. Nothing is deleted automatically on this host.
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onOpenHistory}
        >
          <History className="size-4" />
          <span>Cleanup history</span>
        </Button>
      </div>
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
 * The FUTURE leaf. `useRelativeTimestamp` is a past-tense formatter whose
 * negative-delta clamp renders any upcoming instant as "Just now" - which is
 * exactly what a freshly enabled policy showed for a check ~30s away. A time
 * that has already arrived (the scheduler picks the pass up on its next
 * cadence tick) reads as due rather than as a countdown of zero.
 */
function AutoCleanupNextCheck(props: { readonly at: number }): ReactNode {
  const now = useSampledNow();
  if (props.at <= now) return <>due now</>;
  return <>in {formatResetCountdown(props.at, now)}</>;
}

/**
 * The inactivity threshold: five presets plus a validated free value.
 *
 * Validation reads the HOST's `bounds` rather than a constant here, so a host
 * that moves them needs no client release — and the control can never offer a
 * value the host is about to refuse.
 */
function AutoCleanupThresholdRow(props: {
  readonly policy: WorktreeAutoCleanupPolicyState;
  readonly busy: boolean;
  readonly onCommitDays: (days: number) => void;
}): ReactNode {
  const { policy, busy, onCommitDays } = props;
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
    <div className="border-t border-border/40 px-3.5 py-2.5">
      <div
        className={cn(
          "flex flex-wrap items-center gap-3",
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
