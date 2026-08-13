import { useState, type ReactNode } from "react";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { cn } from "@/lib/utils";
import type { UpdateHostVersionPolicyMutation } from "@/components/settings/host-scope/use-host-registry-update-mutation";
import {
  deriveUpdateAffordance,
  deriveUpdatePill,
} from "@/components/settings/panels/my-hosts-model";

/**
 * The auto-update policy switch.
 *
 * Now inside the Advanced disclosure, apart from the drain gate below, and the
 * split is about urgency rather than topic. This is a preference someone sets
 * once and forgets, so it belongs with the other settings a person opens
 * Advanced to find; "Apply now — ends N sessions" appears only while an update is
 * genuinely blocked on open sessions, and hiding THAT behind a collapsed
 * disclosure would bury the one control here with a deadline on it.
 */
export function HostAutoUpdateRow(props: {
  readonly item: HostListItem;
  readonly mutation: UpdateHostVersionPolicyMutation;
  /** Row chrome is the caller's, since the two rows now sit in different boxes. */
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
        {/* ONE sentence, both vantages. This used to fork on `isLocalHost`,
              saying "Installs new versions when no sessions are running."
              locally — which was fiction. The pin is applied by the HOST's own
              update reconciler, on its own independent ~20s poll, reading the
              coordination snapshot its check-in populates
              (`update-reconciler.ts` — no locality branch anywhere in it). The
              local machine's CLI controller is a different mechanism entirely:
              it backs the MANUAL apply button, not this policy. The fork
              therefore described a path that does not exist, omitted the
              latency that does, and — because the two variants render the same
              component — made the Overview visibly differ for local and remote
              hosts on a page whose whole premise is that it does not. */}
        <p className="text-ui-xs text-muted-foreground">
          Applied on this host&apos;s next check-in (~20s), when no sessions are
          running.
        </p>
      </div>
      {pill === null ? null : (
        <span
          className="shrink-0 rounded-sm bg-muted/70 px-1.5 py-px text-ui-xs text-muted-foreground"
          data-testid={`host-update-pill-${item.hostId}`}
        >
          {pill.label}
        </span>
      )}
    </div>
  );
}

/**
 * "Apply now — ends N sessions", and NOTHING when no update is waiting on
 * sessions.
 *
 * Rendering nothing is the common case by a wide margin, which is exactly why
 * this is a separate component: a row that is usually absent should not decide
 * the layout of the row that is always present.
 */
export function HostUpdateDrainGateRow(props: {
  readonly item: HostListItem;
  readonly mutation: UpdateHostVersionPolicyMutation;
}): ReactNode {
  const { item, mutation } = props;
  const affordance = deriveUpdateAffordance(item.status);
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
      />
    </div>
  );
}

/**
 * "Apply now — ends N sessions" (the drain-gate force): bypasses waiting for
 * open sessions on the CURRENTLY pending update. This is destructive (it ends
 * N open terminal/agent sessions), so it always requires an explicit
 * confirmation through the same `ConfirmDestructiveDialog` this codebase uses
 * for other disruptive host actions — never a casual one-click.
 */
function ApplyNowControl(props: {
  readonly hostId: string;
  readonly label: string;
  readonly mutation: UpdateHostVersionPolicyMutation;
}): ReactNode {
  const { hostId, label, mutation } = props;
  // The TARGET is captured when the dialog is armed, not read when it is
  // confirmed.
  //
  // Only `open` used to live here while `hostId` and `mutation` arrived as
  // props that rebind on every render. Anything that moved the scoped host
  // while this dialog stood open — a switcher pick, or the active host
  // changing from another window — slid a new host underneath it, and
  // confirming then ended the sessions of a host the dialog never named. The
  // copy says "this host"; this is what makes that true.
  const [armedHostId, setArmedHostId] = useState<string | null>(null);
  const open = armedHostId !== null;
  const targetMoved = armedHostId !== null && armedHostId !== hostId;

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => setArmedHostId(hostId)}
        disabled={mutation.isPending}
        data-testid={`host-apply-now-trigger-${hostId}`}
      >
        {label}
      </Button>
      <ConfirmDestructiveDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setArmedHostId(null);
        }}
        title="Apply the update now?"
        description={
          targetMoved
            ? "The host this was aimed at is no longer the one selected. Close this and try again on the host you mean."
            : "This ends every open terminal and agent session on this host so the update can apply immediately. Sessions can be reopened once the host is back."
        }
        cascadeSummary={null}
        actionLabel="Apply now"
        isPending={mutation.isPending}
        onConfirm={() => {
          // Refuse rather than retarget. A destructive action whose subject
          // changed after it was armed has no safe interpretation.
          if (targetMoved) return;
          mutation.mutate(
            { updatePolicy: undefined, desiredVersion: undefined, force: true },
            { onSuccess: () => setArmedHostId(null) },
          );
        }}
      />
    </>
  );
}
