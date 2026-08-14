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
 *
 * Works without a live session on purpose: the policy is stored in the
 * account's host registry and the host reads it on its next check-in, which is
 * what keeps an offline host's Overview useful instead of blank.
 *
 * The DRAIN half is the exception, and it is deliberate. "Waiting for N
 * sessions" and "Apply now — ends N sessions" name a count and then destroy
 * that many sessions, so the count has to come from a live read of the host
 * (`liveBusySessionCount`) rather than from the registry row beside it. It used
 * to come from the cloud DTO, where it could be a lease-interval stale; a host
 * with no live source now shows no drain state at all, which is the only
 * honest answer and — since ending sessions needs a reachable host anyway — not
 * a capability anyone loses.
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
              update reconciler, reading the coordination snapshot its check-in
              populates (`update-reconciler.ts` — no locality branch anywhere in
              it). The local machine's CLI controller is a different mechanism
              entirely: it backs the MANUAL apply button, not this policy. The
              fork therefore described a path that does not exist, omitted the
              latency that does, and — because the two variants render the same
              component — made the Overview visibly differ for local and remote
              hosts on a page whose whole premise is that it does not.

              The stated latency is an UPPER bound, and deliberately so. It used
              to read "~20s", the cadence of the host→cloud heartbeat that fed
              the snapshot; that heartbeat is gone and the ~10-minute token
              refresh carries the same fields now. A host with a live session
              picks it up in seconds instead (the room nudge), but a person
              cannot tell from this row which case they are in, so the copy
              promises the slower one and lets the faster one be a pleasant
              surprise. */}
        <p className="text-ui-xs text-muted-foreground">
          Applied on this host&apos;s next check-in — within ~10 minutes, and
          only when no sessions are running.
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
  /**
   * Open sessions blocking the drain, from `host.status` over the live
   * connection. `null` when this client has no live read of the host — NOT
   * zero.
   *
   * The DISPLAY read. It drives the labels and nothing else.
   */
  readonly liveBusySessionCount: number | null;
  /**
   * The same count from a SETTLED read — nothing in flight, not aged out.
   * Drives the drain force's arm/confirm path, which needs a number it can
   * stand behind rather than one that is merely the best available.
   */
  readonly settledBusySessionCount: number | null;
}): ReactNode {
  const { item, mutation } = props;
  const affordance = deriveUpdateAffordance({
    updateState: item.status.updateState,
    liveBusySessionCount: props.liveBusySessionCount,
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
  /**
   * The count this control may stand behind: `null` unless the `host.status`
   * read is settled. Deliberately NOT the count in `label` — the label may
   * render a retained number through a refetch, and arming a force from a
   * number that is merely retained is the whole failure this split closes.
   */
  readonly settledBusySessionCount: number | null;
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
  // The COUNT is captured with the target, for the same reason and against a
  // sharper failure. This dialog names a number and then destroys that many
  // sessions, and it can stand open while the number moves underneath it.
  // Confirming then ends a quantity nobody was shown. Re-checking at confirm
  // time against what was ARMED is what makes "ends 2 sessions" a promise
  // rather than an estimate.
  //
  // Both ways the number can move now reach this guard, and the `null` arm is
  // the one that changed. A changed count (2 → 3) always did.
  //
  // A LOST count used to be unreachable here: `deriveUpdateAffordance` nulls
  // `applyNowLabel` the moment the DISPLAY read goes away, and
  // `HostRegistryUpdates` gates this whole control on that label, so losing the
  // source unmounted the trigger and any open dialog with it. That is still
  // true of a genuinely lost read. It is NOT true of the case this control now
  // reads instead: a settled count is also lost for the duration of every
  // refetch, while the label keeps rendering the retained number and this stays
  // mounted. So the `null` arms below are live, load-bearing, and the reason
  // this component takes a different number from the one on its own button.
  const [armedCount, setArmedCount] = useState<number | null>(null);
  const open = armedHostId !== null;
  const targetMoved = armedHostId !== null && armedHostId !== hostId;
  // `null` covers "the live source is gone", "it never reported", and "a
  // replacement read is in flight" — the same answer in all three: we cannot
  // currently stand behind the number.
  const countMoved =
    open &&
    (props.settledBusySessionCount === null ||
      props.settledBusySessionCount !== armedCount);
  const refuse = targetMoved || countMoved;

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => {
          setArmedHostId(hostId);
          setArmedCount(props.settledBusySessionCount);
        }}
        // Arming is refused, not merely refused at confirm time, while the
        // count is unsettled. The dialog would open naming a number it would
        // then decline to act on, which is a worse experience than a briefly
        // inert button — and the window is one host RPC over an already-open
        // connection.
        disabled={mutation.isPending || props.settledBusySessionCount === null}
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
        description={describeApplyNowConfirmation({
          targetMoved,
          countMoved,
          armedCount,
          currentCount: props.settledBusySessionCount,
        })}
        cascadeSummary={null}
        actionLabel="Apply now"
        isPending={mutation.isPending}
        onConfirm={() => {
          // Refuse rather than retarget. A destructive action whose subject OR
          // magnitude changed after it was armed has no safe interpretation:
          // the person agreed to end a named number of sessions on a named
          // host, and we no longer have both.
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

/**
 * What the confirmation says, given what may have shifted while it stood open.
 *
 * Both refusals are stated as a REASON plus a next step rather than a disabled
 * button, because the person already decided to do this and deserves to know
 * why it did not happen. The count case is the subtler one: nothing looks
 * broken, the number on the button simply stopped being something we can
 * stand behind.
 *
 * Which is why the "cannot see it" branch keys off `currentCount`, not
 * `armedCount`. Those two used to be the same question, back when losing the
 * read unmounted the whole control — the only way to reach the refusal was for
 * a number to have moved to another number. Now a refetch withdraws the count
 * without withdrawing the control, so the dialog can be armed at 2 and then be
 * unable to see anything; branching on `armedCount` there produced "it is no
 * longer 2" about a number that had not changed at all.
 */
function describeApplyNowConfirmation(input: {
  readonly targetMoved: boolean;
  readonly countMoved: boolean;
  readonly armedCount: number | null;
  readonly currentCount: number | null;
}): string {
  if (input.targetMoved) {
    return "The host this was aimed at is no longer the one selected. Close this and try again on the host you mean.";
  }
  if (input.countMoved) {
    return input.currentCount === null || input.armedCount === null
      ? "We can't currently see how many sessions are open on this host, so we can't say what applying now would end. Close this and try again once the count is back."
      : `The number of open sessions changed since you opened this — it is no longer ${input.armedCount}. Close this and try again so you can see what applying now would end.`;
  }
  return "This ends every open terminal and agent session on this host so the update can apply immediately. Sessions can be reopened once the host is back.";
}
