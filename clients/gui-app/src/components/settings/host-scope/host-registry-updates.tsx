import { useState, type ReactNode } from "react";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { cn } from "@/lib/utils";
import type { UpdateHostVersionPolicyMutation } from "@/components/settings/host-scope/use-host-registry-update-mutation";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";
import { busyWorkPhrase } from "@/components/host/host-restart-copy";
import {
  deriveUpdateAffordance,
  deriveUpdatePill,
} from "@/components/settings/panels/my-hosts-model";

/** Works without a live session on purpose: the policy is stored in the account's host registry and the host
 * reads it on its next check-in, which is what keeps an offline host's Overview useful instead of blank. */
export function HostAutoUpdateRow(props: {
  readonly item: HostListItem;
  readonly mutation: UpdateHostVersionPolicyMutation;
  readonly className: string;
}): ReactNode {
  const { item, mutation } = props;
  const pill = deriveUpdatePill(item.status.updateState);
  const isAuto = item.updatePolicy === "auto";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2",
        props.className,
      )}
    >
      <Switch
        checked={isAuto}
        disabled={mutation.isPending}
        onCheckedChange={(checked) => {
          mutation.mutate({
            updatePolicy: checked ? "auto" : "manual",
            desiredVersion: undefined,
            force: undefined,
          });
        }}
        aria-label={isAuto ? "Turn off auto-update" : "Turn on auto-update"}
        data-testid={`host-auto-update-${item.hostId}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-ui-sm text-foreground">Auto-update</p>
        {/* The fork therefore described a path that does not exist, omitted the latency that does, and - because the
           two variants render the same component. */}
        <p className="text-ui-xs text-muted-foreground">
          Applied on this host&apos;s next check-in — within ~10 minutes, and
          only when no sessions are running.
        </p>
      </div>
      {pill === null ? null : (
        <span
          className="shrink-0 rounded-sm bg-foreground/8 px-1.5 py-px text-ui-xs text-muted-foreground"
          data-testid={`host-update-pill-${item.hostId}`}
        >
          {pill.label}
        </span>
      )}
    </div>
  );
}

/** "Apply now - ends N sessions", and nothing when no update is waiting on sessions. */
export function HostUpdateDrainGateRow(props: {
  readonly item: HostListItem;
  readonly mutation: UpdateHostVersionPolicyMutation;
  /** Open work blocking the drain, from `host.status` over the live connection. */
  readonly liveBusySessionCount: number | null;
  /** Names kinds on the button when present; count copy is retained otherwise. */
  readonly liveBusyBreakdown: HostBusyBreakdown | null;
  /** Drives the drain force's arm/confirm path, which needs a number it can stand behind rather than one that is
   * merely the best available. */
  readonly settledBusySessionCount: number | null;
  /** Captured on arm with the count so a same-total category swap (2 agents → 2 terminals) is a moved promise,
   * not a confirm. */
  readonly settledBusyBreakdown: HostBusyBreakdown | null;
}): ReactNode {
  const { item, mutation } = props;
  const affordance = deriveUpdateAffordance({
    updateState: item.status.updateState,
    liveBusySessionCount: props.liveBusySessionCount,
    liveBusyBreakdown: props.liveBusyBreakdown,
  });
  if (affordance.applyNowLabel === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border/40 px-5 py-3">
      <p className="min-w-0 flex-1 text-ui-sm text-muted-foreground">
        {affordance.waitingForSessionsLabel ??
          "Waiting for open sessions before applying."}
      </p>
      <ApplyNowControl
        hostId={item.hostId}
        label={affordance.applyNowLabel}
        mutation={mutation}
        settledBusySessionCount={props.settledBusySessionCount}
        settledBusyBreakdown={props.settledBusyBreakdown}
      />
    </div>
  );
}

/** This is destructive (it ends N open terminal/agent sessions), so it always requires an explicit confirmation
 * through the same `ConfirmDestructiveDialog` this codebase uses for other disruptive host actions. */
function ApplyNowControl(props: {
  readonly hostId: string;
  readonly label: string;
  readonly mutation: UpdateHostVersionPolicyMutation;
  /** Deliberately not the count in `label` - the label may render a retained number through a refetch, and arming
   * a force from a number that is merely retained is the whole failure this split closes. */
  readonly settledBusySessionCount: number | null;
  /** The settled split captured with the count. A same-total category swap is a moved promise: arming "ends 2
   * agents" must not confirm after those agents finish and two terminals start. */
  readonly settledBusyBreakdown: HostBusyBreakdown | null;
}): ReactNode {
  const { hostId, label, mutation } = props;
  // The target is captured when the dialog is armed, not read when it is confirmed.
  const [armedHostId, setArmedHostId] = useState<string | null>(null);
  // Re-checking at confirm time against what was armed is what makes "ends 2 agents" a promise rather than an
  // estimate.
  const [armedCount, setArmedCount] = useState<number | null>(null);
  const [armedBreakdown, setArmedBreakdown] =
    useState<HostBusyBreakdown | null>(null);
  const open = armedHostId !== null;
  const targetMoved = armedHostId !== null && armedHostId !== hostId;
  // `null` covers "the live source is gone", "it never reported", and "a replacement read is in flight" - the
  // same answer in all three: we cannot currently stand behind the number.
  const countMoved =
    open &&
    (props.settledBusySessionCount === null ||
      props.settledBusySessionCount !== armedCount);
  const breakdownMoved =
    open && !sameBusyBreakdown(armedBreakdown, props.settledBusyBreakdown);
  const refuse = targetMoved || countMoved || breakdownMoved;

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => {
          setArmedHostId(hostId);
          setArmedCount(props.settledBusySessionCount);
          setArmedBreakdown(props.settledBusyBreakdown);
        }}
        // Arming is refused, not merely refused at confirm time, while the count is unsettled.
        disabled={mutation.isPending || props.settledBusySessionCount === null}
        data-testid={`host-apply-now-trigger-${hostId}`}
      >
        {label}
      </Button>
      <ConfirmDestructiveDialog
        blockedReason={null}
        open={open}
        onOpenChange={(next) => {
          if (!next) setArmedHostId(null);
        }}
        title="Apply the update now?"
        description={describeApplyNowConfirmation({
          targetMoved,
          countMoved,
          breakdownMoved,
          armedCount,
          currentCount: props.settledBusySessionCount,
          armedBreakdown,
          currentBreakdown: props.settledBusyBreakdown,
        })}
        cascadeSummary={null}
        actionLabel="Apply now"
        isPending={mutation.isPending}
        onConfirm={() => {
          // Refuse rather than retarget.
          if (refuse) return;
          mutation.mutate(
            { updatePolicy: undefined, desiredVersion: undefined, force: true },
            { onSuccess: () => setArmedHostId(null) },
          );
        }}
      />
    </>
  );
}

/** Which is why the "cannot see it" branch keys off `currentCount`, not `armedCount`. */
function describeApplyNowConfirmation(input: {
  readonly targetMoved: boolean;
  readonly countMoved: boolean;
  readonly breakdownMoved: boolean;
  readonly armedCount: number | null;
  readonly currentCount: number | null;
  readonly armedBreakdown: HostBusyBreakdown | null;
  readonly currentBreakdown: HostBusyBreakdown | null;
}): string {
  if (input.targetMoved) {
    return "The host this was aimed at is no longer the one selected. Close this and try again on the host you mean.";
  }
  if (input.countMoved || input.breakdownMoved) {
    const lost =
      input.currentCount === null ||
      (input.armedBreakdown !== null && input.currentBreakdown === null);
    if (lost) {
      return input.armedBreakdown === null
        ? "We can't currently see how many sessions are open on this host, so we can't say what applying now would end. Close this and try again once the count is back."
        : "We can't currently see what is working on this host, so we can't say what applying now would end. Close this and try again once that is visible again.";
    }
    if (input.breakdownMoved) {
      const was =
        input.armedBreakdown === null
          ? `${input.armedCount} sessions`
          : (busyWorkPhrase(input.armedBreakdown) ?? "that work");
      return `The work applying now would end changed since you opened this — it is no longer ${was}. Close this and try again so you can see what applying now would end.`;
    }
    return `The number of open sessions changed since you opened this — it is no longer ${input.armedCount}. Close this and try again so you can see what applying now would end.`;
  }
  return "This ends every open terminal and agent session on this host so the update can apply immediately. Sessions can be reopened once the host is back.";
}

function sameBusyBreakdown(
  left: HostBusyBreakdown | null,
  right: HostBusyBreakdown | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.workingAgents === right.workingAgents &&
    left.activeTerminalAgents === right.activeTerminalAgents &&
    left.busyTerminals === right.busyTerminals
  );
}
