import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import type { WorktreeAutoCleanupPolicyState } from "@traycer/protocol/host/worktree-auto-cleanup-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { useWorktreeCleanupViewStore } from "@/stores/settings/worktree-cleanup-view-store";

/**
 * Settings ▸ Worktrees ▸ Automatic cleanup — the per-HOST opt-in, as ONE chip
 * in the inventory's own toolbar.
 *
 * Default off, and the switch inside the popover is the whole opt-in: nothing
 * here schedules, simulates or retries cleanup client-side. A host that does
 * not advertise the capability renders a disabled chip with the explanation in
 * a tooltip and no popover at all, because deletion authority is the host's
 * alone.
 *
 * The chip replaced a card above the list. The panel is a fixed height, so
 * every row that card spent was a worktree the list below could not show — and
 * it spent them unconditionally, for a policy that is consulted rarely and
 * changed almost never. A chip costs the list nothing: it rides in a toolbar
 * row that already exists.
 *
 * Sits ABOVE `HostScopeGate` in the standalone-toolbar path (the inventory owns
 * that gate), so it makes the two checks the gate would otherwise make for it —
 * scope usability and reachability — before mounting any host read.
 */
export function WorktreeAutoCleanupChip(props: {
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
    return (
      <AutoCleanupUnavailableChip gate={gate} hostLabel={scope.hostLabel} />
    );
  }
  // Unreachable: `resolveAutoCleanupGate` answers "absent" without a host, so
  // "ready" already proves this. Restated for the type system rather than
  // asserted, so the two can never disagree silently.
  if (hostId === null) return null;
  // Keyed by host: switching the sidebar straight from one usable host to
  // another keeps this position in the tree, and the popover's open state is
  // per host, not per panel visit. Remounting is what makes "every host starts
  // closed" true rather than merely intended.
  return (
    <AutoCleanupPolicyChip
      key={hostId}
      hostId={hostId}
      client={scope.client}
      onOpenHistory={onOpenHistory}
    />
  );
}

/** The chip's shell, shared by the live and the unavailable forms. */
const AUTO_CLEANUP_CHIP_CLASS =
  "inline-flex min-w-0 max-w-full shrink items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-ui-xs text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The status dot, or nothing while the policy is still unknown.
 *
 * "Unknown" deliberately shows no dot rather than a third colour: a grey dot
 * already MEANS off, and a chip that paints one before the read lands would be
 * claiming a policy state it has not been told.
 */
function AutoCleanupChipFace(props: {
  readonly tone: "on" | "off" | "unknown";
  readonly label: string;
}): ReactNode {
  return (
    <>
      {props.tone === "unknown" ? null : (
        <span
          data-testid="worktree-auto-cleanup-chip-dot"
          data-tone={props.tone}
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            props.tone === "on"
              ? "bg-emerald-500 dark:bg-emerald-400"
              : "bg-muted-foreground/50",
          )}
          aria-hidden
        />
      )}
      <span className="min-w-0 truncate">{props.label}</span>
    </>
  );
}

/**
 * `checking` / `offline` / `unsupported`: the chip is there, inert, and says
 * why when pointed at.
 *
 * `aria-disabled` rather than the `disabled` attribute, deliberately. A
 * disabled button receives no pointer events and cannot take focus, so the one
 * thing this chip exists to deliver — the sentence explaining what is wrong
 * with the host — would be unreachable by mouse AND by keyboard. It carries no
 * handler and no popover, so nothing happens when it is pressed.
 */
function AutoCleanupUnavailableChip(props: {
  readonly gate: Exclude<AutoCleanupGate, "absent" | "ready">;
  readonly hostLabel: string;
}): ReactNode {
  return (
    <TooltipWrapper
      label={autoCleanupUnavailableCopy(props.gate, props.hostLabel)}
      side="bottom"
      sideOffset={undefined}
      align="start"
    >
      <button
        type="button"
        aria-disabled
        aria-label="Automatic cleanup settings"
        data-testid="worktree-auto-cleanup-chip"
        data-gate={props.gate}
        className={cn(AUTO_CLEANUP_CHIP_CLASS, "cursor-not-allowed opacity-60")}
      >
        <AutoCleanupChipFace tone="unknown" label="Cleanup" />
      </button>
    </TooltipWrapper>
  );
}

/**
 * `offline` and `unsupported` are deliberately different sentences: one calls
 * for starting a machine, the other for updating it.
 */
function autoCleanupUnavailableCopy(
  gate: Exclude<AutoCleanupGate, "absent" | "ready">,
  hostLabel: string,
): string {
  if (gate === "checking") {
    return `Checking whether ${hostLabel} can run automatic cleanup…`;
  }
  if (gate === "offline") {
    return `Automatic cleanup settings are unavailable while ${hostLabel} is offline. Cleanup runs on that host, so it resumes on its own when the host is running again.`;
  }
  return `${hostLabel} is running a version without automatic cleanup. Update the host to turn it on — nothing is scheduled from here.`;
}

/** "Cleanup · On · 7d" / "Cleanup off" / "Cleanup" until the read lands. */
function autoCleanupChipLabel(
  policy: WorktreeAutoCleanupPolicyState | null,
): string {
  if (policy === null) return "Cleanup";
  if (!policy.enabled) return "Cleanup off";
  return `Cleanup · On · ${String(policy.inactivityDays)}d`;
}

/**
 * The live chip and everything behind it.
 *
 * The read is mounted eagerly rather than on open: the chip's whole job is to
 * state the policy at a glance, so a status that only appears once someone
 * clicks would leave the toolbar saying nothing.
 */
function AutoCleanupPolicyChip(props: {
  /** The host this chip administers. Non-null: `gate === "ready"` proves it. */
  readonly hostId: string;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly onOpenHistory: () => void;
}): ReactNode {
  const { client, onOpenHistory } = props;
  const policyQuery = useWorktreeAutoCleanupPolicy(client, true);
  const setPolicy = useWorktreeSetAutoCleanupPolicy(client);
  const policy = policyQuery.data ?? null;
  // Component-local and never persisted. Closed is this chip's resting shape on
  // every mount, so re-entering Settings or switching hosts starts closed
  // rather than restoring someone's last visit to the threshold.
  const [open, setOpen] = useState(false);
  // The one-shot "take me to automatic cleanup" request another surface left
  // behind (the Sweep dialog's discovery line). Matched by HOST and left alone
  // otherwise: the policy is per host and this chip administers exactly one, so
  // a request whose host never mounted a chip — offline, too old, or Settings
  // never opened — must not be spent on whichever host is scoped next.
  const requestedHostId = useWorktreeCleanupViewStore(
    (state) => state.autoCleanupFocusHostId,
  );
  const requested = requestedHostId === props.hostId;
  // Consumed during RENDER (React's documented way to react to a changing
  // external value), not in an effect. The popover has to be open in the same
  // commit for Radix's mount autofocus to move the caret into it, and an
  // effect that opened it would both arrive a frame late and be exactly what
  // `react-hooks/set-state-in-effect` forbids.
  if (requested && !open) setOpen(true);
  useEffect(() => {
    if (!requested) return;
    // Cleared the moment it is acted on, so a later visit to Settings does not
    // re-open a popover nobody asked about this time.
    useWorktreeCleanupViewStore.getState().clearAutoCleanupFocus();
  }, [requested]);

  const setEnabled = useCallback(
    (next: boolean) => {
      if (policy === null) return;
      setPolicy.mutate({
        enabled: next,
        inactivityDays: policy.inactivityDays,
        expectedRevision: policy.revision,
      });
    },
    [policy, setPolicy],
  );
  const commitDays = useCallback(
    (days: number) => {
      if (policy === null) return;
      setPolicy.mutate({
        enabled: policy.enabled,
        inactivityDays: days,
        expectedRevision: policy.revision,
      });
    },
    [policy, setPolicy],
  );
  const openHistory = useCallback(() => {
    setOpen(false);
    onOpenHistory();
  }, [onOpenHistory]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label="Automatic cleanup settings"
          data-testid="worktree-auto-cleanup-chip"
          className={cn(
            AUTO_CLEANUP_CHIP_CLASS,
            "hover:bg-foreground/5 hover:text-foreground",
          )}
        >
          <AutoCleanupChipFace
            tone={autoCleanupChipTone(policy)}
            label={autoCleanupChipLabel(policy)}
          />
        </button>
      </PopoverTrigger>
      <AutoCleanupPopoverPanel
        policy={policy}
        busy={setPolicy.isPending}
        pending={policyQuery.isPending}
        readError={policyQuery.isError ? policyQuery.error.message : null}
        conflicted={isAutoCleanupRevisionConflict(setPolicy.error)}
        onSetEnabled={setEnabled}
        onCommitDays={commitDays}
        onOpenHistory={openHistory}
      />
    </Popover>
  );
}

function autoCleanupChipTone(
  policy: WorktreeAutoCleanupPolicyState | null,
): "on" | "off" | "unknown" {
  if (policy === null) return "unknown";
  return policy.enabled ? "on" : "off";
}

/**
 * Everything the card used to hold, in the order it held it: the switch, what
 * cleanup actually does, the threshold, and the schedule with the way into the
 * record of what it did.
 *
 * A policy that deletes nothing has nothing to configure, so the threshold and
 * the schedule are simply absent while it is off — not disabled controls over
 * an inert setting.
 *
 * Renders the `PopoverContent` itself rather than sitting inside one, so the
 * component that owns the SWITCH also owns the open-focus decision and the ref
 * behind it. A ref threaded down as a prop would make every other prop of this
 * component unreadable during render, which is precisely what
 * `react-hooks/refs` forbids.
 */
function AutoCleanupPopoverPanel(props: {
  readonly policy: WorktreeAutoCleanupPolicyState | null;
  readonly busy: boolean;
  readonly pending: boolean;
  readonly readError: string | null;
  readonly conflicted: boolean;
  readonly onSetEnabled: (next: boolean) => void;
  readonly onCommitDays: (days: number) => void;
  readonly onOpenHistory: () => void;
}): ReactNode {
  const { policy, busy } = props;
  const enabled = policy !== null && policy.enabled;
  // Where the caret lands on open. Radix parks it on the content container, a
  // `tabIndex={-1}` div — but a keyboard arrival, and the Sweep dialog's deep
  // link in particular, has to reach the SWITCH, which is the whole opt-in.
  const switchRef = useRef<HTMLButtonElement | null>(null);
  // The switch is DISABLED until the policy read lands, and a deep link opens
  // this popover on the very first frame — so the mount-time placement below
  // can aim at a control that cannot take focus yet. This is the second half:
  // it claims the caret the moment the switch can hold it, and only FROM the
  // container Radix parked it on. Once the person has moved focus themselves,
  // it is theirs.
  const focusable = policy !== null && !busy;
  useEffect(() => {
    if (!focusable) return;
    const node = switchRef.current;
    if (node === null) return;
    const active = document.activeElement;
    if (active === null) return;
    if (active.getAttribute("data-slot") !== "popover-content") return;
    node.focus();
  }, [focusable]);
  return (
    <PopoverContent
      align="start"
      side="bottom"
      className="w-[min(88vw,20rem)]"
      data-testid="worktree-auto-cleanup-popover"
      onOpenAutoFocus={(event) => {
        const node = switchRef.current;
        if (node === null || node.hasAttribute("disabled")) return;
        event.preventDefault();
        node.focus();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className="min-w-0 text-ui-sm font-medium text-foreground"
          data-testid="worktree-auto-cleanup-title"
        >
          Automatic cleanup
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {busy ? (
            <AgentSpinningDots
              className="text-muted-foreground"
              testId="worktree-auto-cleanup-saving"
              variant={undefined}
            />
          ) : null}
          <Switch
            ref={switchRef}
            aria-label="Automatic cleanup"
            checked={enabled}
            disabled={policy === null || busy}
            onCheckedChange={props.onSetEnabled}
          />
        </div>
      </div>
      {policy !== null && !enabled ? (
        <p className="text-ui-xs text-muted-foreground">
          Nothing is deleted automatically.
        </p>
      ) : null}
      {enabled ? (
        <AutoCleanupThresholdEditor
          policy={policy}
          busy={busy}
          onCommitDays={props.onCommitDays}
        />
      ) : null}
      <AutoCleanupStatusLines
        pending={props.pending}
        readError={props.readError}
        conflicted={props.conflicted}
      />
      {policy !== null && policy.pausedReason !== null ? (
        <p
          role="status"
          data-testid="worktree-auto-cleanup-paused"
          className="text-ui-xs text-pretty text-amber-700 dark:text-amber-300"
        >
          {AUTO_CLEANUP_PAUSED_COPY[policy.pausedReason]}
        </p>
      ) : null}
      {enabled ? (
        <AutoCleanupFooterRow
          policy={policy}
          onOpenHistory={props.onOpenHistory}
        />
      ) : null}
    </PopoverContent>
  );
}

/** Loading, the read's failure, and the write's one non-toasted rejection. */
function AutoCleanupStatusLines(props: {
  readonly pending: boolean;
  readonly readError: string | null;
  readonly conflicted: boolean;
}): ReactNode {
  return (
    <>
      {props.pending ? (
        <p className="text-ui-xs text-muted-foreground">
          Loading automatic cleanup settings…
        </p>
      ) : null}
      {props.readError !== null ? (
        <p role="alert" className="text-ui-xs text-pretty text-destructive">
          {props.readError}
        </p>
      ) : null}
      {props.conflicted ? (
        <p
          role="alert"
          data-testid="worktree-auto-cleanup-conflict"
          className="text-ui-xs text-pretty text-amber-700 dark:text-amber-300"
        >
          Automatic cleanup was changed somewhere else. The current setting is
          shown above — apply your change again if you still want it.
        </p>
      ) : null}
    </>
  );
}

/**
 * When the host last looked and when it looks next, plus the way into the
 * record of what it did.
 *
 * History records AUTOMATIC runs only — manual deletions never appear in it —
 * so the link belongs to the enabled policy and nowhere else. With cleanup off,
 * a link here read as the place manual deletions should show up. The rows
 * themselves persist (retention is 200 runs / 90 days), so re-enabling brings
 * the record back.
 */
function AutoCleanupFooterRow(props: {
  readonly policy: WorktreeAutoCleanupPolicyState;
  readonly onOpenHistory: () => void;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-border/40 pt-2">
      <AutoCleanupSchedule policy={props.policy} />
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto shrink-0 p-0 text-ui-xs"
        onClick={props.onOpenHistory}
      >
        <span>History</span>
        <ChevronRight className="size-3.5" aria-hidden />
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
 * the page for as long as the popover is open.
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

/** Leaf, so the shared 60s clock repaints the label and not the whole chip. */
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
 * What cleanup actually does, then the inactivity threshold — five presets plus
 * a validated free value.
 *
 * Validation reads the HOST's `bounds` rather than a constant here, so a host
 * that moves them needs no client release — and the control can never offer a
 * value the host is about to refuse.
 */
function AutoCleanupThresholdEditor(props: {
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
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-ui-xs text-pretty text-muted-foreground">
        Removes worktrees on this host that have been inactive and stay proven
        safe to delete. Age alone never makes one safe.
      </p>
      <span className="text-ui-xs font-medium text-foreground">
        Inactive for
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Presets commit without the custom input's validation, so a preset
            the host's bounds exclude is not offered at all rather than being a
            button that sends a value the host will refuse. */}
        {AUTO_CLEANUP_DAY_PRESETS.filter(
          (days) =>
            days >= policy.bounds.minDays && days <= policy.bounds.maxDays,
        ).map((days) => (
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
          className="h-8 w-[min(30vw,4.5rem)] text-ui-sm"
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
      {error !== null ? (
        <p id={errorId} role="alert" className="text-ui-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
