import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { SweepWorktreesDialog } from "@/components/epics/sweep-worktrees-dialog";
import { sweepNeedsHostPicker } from "@/components/epics/sweep-host-model";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";

/**
 * Where a Sweep is: shut, waiting on the fleet, on the surface's own client,
 * or carrying a choice.
 *
 * There is no "picking" arm, and its absence is the design. A standalone host
 * step could only ask the question a screen away from the census that answers
 * it, so the census now carries the question: the dialog opens on the host the
 * surface is pointed at, and the host is a control inside it.
 *
 * The arms are separate rather than one arm with flags, because they answer to
 * different authorities and only the union makes that unmistakable. `pending`
 * is nobody's answer yet - the directory has not said what the fleet is.
 * `surface` is the path a one-usable-host account takes: nobody was asked, the
 * surface's own client IS the answer, and it stays the answer for the life of
 * the dialog exactly as it did before multi-host Sweep existed. `choice`
 * LATCHES a host id, and from then on the fleet plane may not move it - only
 * `onSwitch` may.
 *
 * That latch is why `choice` reads `openedOnHostId` and never the live props.
 * History hands this flow the app-wide effective-host FOLLOWER, whose entire
 * contract is to re-render with a different host's client when selection fails
 * over. Interpreting "the surface's host" by dereferencing those props on
 * every render let a failover retarget an open, already-reviewed Sweep with no
 * gesture from anybody - the dialog's session key would move, and
 * `applySelectionRetarget` would discard the proof and the choices made
 * against it.
 *
 * **Every arm but `closed` renders a dialog.** Each caller arms its own "sweep
 * is open" state and disarms it from `onOpenChange`, so any state that
 * rendered nothing would strand the request with no way to see or cancel it.
 * That is why `pending` exists at all, and why a `choice` with no host yet
 * opens and asks instead of waiting for one.
 */
interface SweepHostChoicePhase {
  readonly kind: "choice";
  /**
   * The host this Sweep opened on. Latched; only ever rewritten from `null`.
   *
   * `null` is the UNCHOSEN state: the fleet has a choice in it and the surface
   * could not name the host it is pointed at, so nobody has answered "which
   * machine" yet. The dialog still OPENS - it asks, on the chip, and runs no
   * census until it is answered. It deliberately does not wait invisibly:
   * every caller clears its own "sweep is open" state from `onOpenChange`, so
   * a flow that renders nothing leaves the request armed with no dialog, no
   * spinner and no way to cancel it.
   */
  readonly openedOnHostId: string | null;
  /** Where a person has since sent it. `null` ⇒ still the opened host. */
  readonly switchedHostId: string | null;
  /** The target before the pending switch — the one step back is to here. */
  readonly previousSwitchedHostId: string | null;
  /**
   * The current target has been seen to resolve at least once.
   *
   * This is what separates "the host you just picked cannot be dialled" from
   * "the host you have been working on has since gone away". The first is a
   * failed gesture and is answered by undoing it; the second is the fleet
   * plane, and answering THAT by moving the dialog would hand a live
   * confirmation another machine's worktrees.
   */
  readonly settled: boolean;
}

type SweepFlowPhase =
  | { readonly kind: "closed" }
  | { readonly kind: "pending" }
  | { readonly kind: "surface" }
  | SweepHostChoicePhase;

const CLOSED: SweepFlowPhase = { kind: "closed" };
/**
 * A Sweep somebody clicked, before the directory has said what the fleet is.
 *
 * It is a phase rather than a return, because the alternative is a click that
 * produces nothing at all: every caller arms its own "sweep is open" state and
 * disarms it from `onOpenChange`, so a flow that renders nothing leaves the
 * request armed with no dialog to cancel - and a directory query that never
 * settles makes that permanent. The dialog opens and says what it is doing.
 *
 * It shows no chip. Not "Choose a host" either: we do not yet know whether
 * this account HAS a choice, and flashing a chooser at a single-host install
 * is the byte-identical promise broken for the length of a query.
 */
const PENDING: SweepFlowPhase = { kind: "pending" };
const SURFACE: SweepFlowPhase = { kind: "surface" };

interface SweepWorktreesFlowProps {
  /**
   * The Tasks being swept, exactly as `SweepWorktreesDialog` takes them.
   * `null` (or empty) keeps the whole flow closed.
   */
  readonly epicIds: ReadonlyArray<string> | null;
  /**
   * The client this surface already speaks on - History's app-wide follower,
   * the Epic status row's session client. It is what a single-host install
   * sweeps with, unchanged and un-rerouted: no chip appears there, so that
   * path is byte-for-byte what it was.
   */
  readonly surfaceHostClient: HostClient<HostRpcRegistry> | null;
  /** The host id behind `surfaceHostClient` — the host the chip opens on. */
  readonly surfaceHostId: string | null;
  /**
   * Hosts the selected Task(s)' node records name, for the popover's badges
   * and the empty state's redirect. Derived client-side from records the
   * surface already holds; an empty set is legal and simply badges nothing.
   */
  readonly occupiedHostIds: ReadonlySet<string>;
  readonly taskTitle: string | null;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * Sweep, end to end: open the confirmation on the host in front of you, and
 * let a person move it when the fleet gives them somewhere to move it to.
 *
 * The confirmation dialog, its candidates query and the sweep mutation are
 * untouched by this - they already take a caller-resolved client, and this is
 * simply a caller that can resolve more than one. Everything Sweep's safety
 * rests on is therefore preserved by construction rather than by care: the
 * census is still the dialog's own cheap walk, the authorization is still its
 * forced act-time proof, and the swept `hostId` is still frozen from that
 * proof.
 *
 * **An open dialog is re-pointed only by the person in front of it.** Three
 * things could otherwise move it, and each is refused here by name: the fleet
 * collapsing (the choice is latched at open, never re-derived), the SURFACE's
 * own host failing over underneath it (`followsSurfaceClient`), and a settled
 * target later going unreachable (`settled`). A switch that a person does make
 * is a new session, which the dialog's own `hostId + epicIds` key already
 * treats as a retarget - checks, step, snapshot and outcomes all reset, and
 * the new host is proven from scratch.
 */
export function SweepWorktreesFlow(props: SweepWorktreesFlowProps): ReactNode {
  const { epicIds } = props;
  // Keyed on the SELECTION rather than the array identity, matching the
  // dialog's own retarget rule: re-opening the same Tasks is a new decision,
  // re-rendering with an equal list is not.
  const selectionKey =
    epicIds === null || epicIds.length === 0
      ? null
      : [...new Set(epicIds)].sort().join(",");
  const fleet = useConnectableHostIds();
  const [decidedKey, setDecidedKey] = useState<string | null>(null);
  const [phase, setPhase] = useState<SweepFlowPhase>(CLOSED);
  // The host a person asked for and the app could not build a client to. It is
  // the chip's inline error, and it is deliberately NOT a phase arm: the flow
  // is still open on a real host, which is the whole point of the fallback.
  const [unavailableHostId, setUnavailableHostId] = useState<string | null>(
    null,
  );

  // The React-recommended "adjust state during render" idiom, as used by the
  // dialog below for its own retargeting.
  if (selectionKey !== decidedKey) {
    applySelectionChange({
      selectionKey,
      phaseKind: phase.kind,
      fleet,
      surfaceHostId: props.surfaceHostId,
      setDecidedKey,
      setPhase,
      setUnavailableHostId,
    });
  }

  const choice = phase.kind === "choice" ? phase : null;
  const targetHostId =
    choice === null ? null : (choice.switchedHostId ?? choice.openedOnHostId);
  const lateSurfaceHostId = lateSurfaceHostToAdopt({
    choice,
    surfaceHostId: props.surfaceHostId,
    unavailableHostId,
  });
  if (choice !== null && lateSurfaceHostId !== null) {
    setPhase({ ...choice, openedOnHostId: lateSurfaceHostId });
  }
  const clientSource = sweepClientSource(phase, props.surfaceHostId);
  const pinnedHostId = clientSource === "pinned" ? targetHostId : null;
  // The sanctioned seam, given the id the person chose. `null` while nothing
  // is pinned resolves the app-wide follower, which this flow then ignores in
  // favour of the surface's own client - the two are the same object on
  // History and deliberately are not inside an Epic session.
  const pinnedHostClient = useHostClientForHostId(pinnedHostId);
  // Asked only where an id is actually being resolved. While the surface's own
  // client is the answer, this seam is being called with `null` and answers
  // with the app-wide follower - a value about a question nobody asked here,
  // and reading it as "the target resolved" (or did not) would be a verdict on
  // a host we never looked up.
  if (choice !== null && pinnedHostId !== null) {
    resolveSwitchTarget({
      choice,
      resolved: pinnedHostClient !== null,
      setPhase,
      setUnavailableHostId,
    });
  }

  return (
    <SweepWorktreesDialog
      epicIds={phase.kind === "closed" ? null : epicIds}
      hostClient={sweepHostClient({
        source: clientSource,
        surfaceHostClient: props.surfaceHostClient,
        pinnedHostClient,
      })}
      taskTitle={props.taskTitle}
      fleetPending={phase.kind === "pending"}
      hostChoice={
        choice === null
          ? null
          : {
              hostId: targetHostId,
              occupiedHostIds: props.occupiedHostIds,
              unavailableHostId,
              onSwitch: (hostId) => {
                setUnavailableHostId(null);
                setPhase((current) =>
                  current.kind === "choice"
                    ? {
                        ...current,
                        switchedHostId: hostId,
                        previousSwitchedHostId: current.switchedHostId,
                        settled: false,
                      }
                    : current,
                );
              },
            }
      }
      onOpenChange={props.onOpenChange}
    />
  );
}

/**
 * The host an UNCHOSEN Sweep should quietly adopt, or `null` to keep asking.
 *
 * An unchosen dialog whose surface has since found its host takes it in
 * silence: nothing is invested yet - no census has run and no row has been
 * touched - and it is the same machine the window is on, so this is the latch
 * arriving late rather than a re-point.
 *
 * It stops once a person reaches for a host themselves, and the two halves of
 * that are unequal. A pick that SUCCEEDED needs no guard here: the target is
 * `switchedHostId ?? openedOnHostId`, so what this writes is already shadowed.
 * A pick that FAILED does, because the undo returns the target to
 * `openedOnHostId` - adopting there would silently census the window's host
 * under a chip still reading "couldn't reach Studio — choose another host".
 * `unavailableHostId` is exactly the failed-pick signal, so it is the guard.
 *
 * That reasoning depends on the undo landing in the SAME render as the pick,
 * which it does because the target is resolved synchronously. Make settling
 * asynchronous and a pick would need its own guard here again.
 */
function lateSurfaceHostToAdopt(input: {
  readonly choice: SweepHostChoicePhase | null;
  readonly surfaceHostId: string | null;
  readonly unavailableHostId: string | null;
}): string | null {
  if (input.choice === null || input.surfaceHostId === null) return null;
  if (input.choice.openedOnHostId !== null) return null;
  if (input.unavailableHostId !== null) return null;
  return input.surfaceHostId;
}

/**
 * Which client the census runs on, as one named answer.
 *
 * - `unchosen` — no host is named, either because nobody has chosen one yet or
 *   because the fleet has not been described yet. It must be its OWN answer
 *   rather than a fallthrough: `useHostClientForHostId` answers a `null` id
 *   with the app-wide follower, so "no host" resolving through the same path
 *   as "this host" would quietly walk whichever machine the window happens to
 *   be on - under a dialog that is telling the person it has not started.
 * - `surface` — the surface's own object, which is what a single-host install
 *   has always swept with and, on the Epic status row, is the SESSION's client
 *   rather than something this flow could rebuild from an id. Used only while
 *   the surface still names the host this Sweep latched.
 * - `pinned` — the latched id, resolved through the seam. Taken the moment the
 *   surface points elsewhere, because following it there would be a failover
 *   retargeting a live confirmation.
 */
type SweepClientSource = "unchosen" | "surface" | "pinned";

/** The client each source names, kept beside the rule that picks one. */
function sweepHostClient(input: {
  readonly source: SweepClientSource;
  readonly surfaceHostClient: HostClient<HostRpcRegistry> | null;
  readonly pinnedHostClient: HostClient<HostRpcRegistry> | null;
}): HostClient<HostRpcRegistry> | null {
  switch (input.source) {
    case "unchosen":
      return null;
    case "surface":
      return input.surfaceHostClient;
    case "pinned":
      return input.pinnedHostClient;
  }
}

function sweepClientSource(
  phase: SweepFlowPhase,
  surfaceHostId: string | null,
): SweepClientSource {
  if (phase.kind === "pending") return "unchosen";
  if (phase.kind !== "choice") return "surface";
  const choice = phase;
  if (choice.switchedHostId === null && choice.openedOnHostId === null) {
    return "unchosen";
  }
  if (
    choice.switchedHostId === null &&
    surfaceHostId === choice.openedOnHostId
  ) {
    return "surface";
  }
  return "pinned";
}

/**
 * Opens, closes, or waits — the once-per-selection decision.
 *
 * It defers the DECISION on an unanswered directory - an unanswered one is not
 * an empty one, and deciding against it would hand a multi-host account the
 * single-host path for the one open where it matters - but it never defers the
 * DIALOG. Those used to be the same thing, and that is the bug both of the
 * open-time states below exist to close.
 *
 * Every caller arms its own "sweep is open" state and disarms it from
 * `onOpenChange`, so any render that produces no dialog leaves the request
 * armed with no way to see it, cancel it, or wait it out - permanently, if
 * whatever we were waiting for never arrives. So a click always opens
 * something honest: `pending` while the directory is still answering, and
 * `choice` with no host yet ("unchosen") when the fleet has a choice in it but
 * the surface cannot name the machine it is on. Both say what they are, both
 * census nothing, and both Cancel.
 */
function applySelectionChange(input: {
  readonly selectionKey: string | null;
  /** The phase this render started on — see the `pending` guard below. */
  readonly phaseKind: SweepFlowPhase["kind"];
  readonly fleet: {
    readonly hostIds: readonly string[];
    readonly resolved: boolean;
  };
  readonly surfaceHostId: string | null;
  readonly setDecidedKey: (key: string | null) => void;
  readonly setPhase: (phase: SweepFlowPhase) => void;
  readonly setUnavailableHostId: (hostId: string | null) => void;
}): void {
  if (input.selectionKey === null) {
    input.setDecidedKey(null);
    input.setPhase(CLOSED);
    input.setUnavailableHostId(null);
    return;
  }
  if (!input.fleet.resolved) {
    // Open, and leave `decidedKey` alone so this re-runs on the render the
    // directory answers on. Nothing is invested while pending - no census, no
    // chip, no host - so the decision that follows re-points nothing.
    //
    // Guarded on the CURRENT phase because `decidedKey` stays behind: this
    // block runs on every render until the directory answers, and a
    // render-phase `setPhase` is not bailed out of by value equality, so an
    // unguarded write here is an infinite render loop rather than a no-op.
    if (input.phaseKind !== "pending") input.setPhase(PENDING);
    return;
  }
  input.setDecidedKey(input.selectionKey);
  input.setUnavailableHostId(null);
  if (!sweepNeedsHostPicker(input.fleet.hostIds)) {
    input.setPhase(SURFACE);
    return;
  }
  input.setPhase({
    kind: "choice",
    // `null` when the surface cannot name its host — the unchosen state.
    openedOnHostId: input.surfaceHostId,
    switchedHostId: null,
    previousSwitchedHostId: null,
    // The opened host is settled by definition: it is where the surface was
    // already pointed, not something a person just reached for.
    settled: true,
  });
}

/**
 * Resolves a just-requested switch, once, into either a settled target or an
 * undone gesture.
 *
 * The undo is the honest answer to a pick that cannot be dialled. Handing the
 * confirmation a null client instead paints an empty census - the query gates
 * on readiness, so it never fetches and never reports pending - and in a tool
 * whose whole job is finding leftovers, "nothing to clean up here" is a claim
 * we have not earned when the truth is that we could not ask.
 *
 * The undo is bounded to an UNSETTLED target, and that bound is the point.
 * Selectable popover rows ask this same seam for themselves, so a pick
 * resolves in the very next render or not at all; a null after that is not a
 * failed gesture but a machine that has since left - deregistered, or its
 * lease released - and answering that by moving the dialog would let the fleet
 * plane re-point a confirmation somebody is part-way through. That case holds
 * its host and lets the dialog say it cannot reach it.
 */
function resolveSwitchTarget(input: {
  readonly choice: SweepHostChoicePhase;
  readonly resolved: boolean;
  readonly setPhase: (phase: SweepFlowPhase) => void;
  readonly setUnavailableHostId: (hostId: string | null) => void;
}): void {
  const { choice } = input;
  if (input.resolved) {
    if (choice.settled) return;
    input.setPhase({ ...choice, settled: true });
    return;
  }
  // A target that has ALREADY resolved once and has since stopped is not a
  // failed gesture - nobody just reached for it - so there is nothing to undo.
  // Holding it is what keeps the fleet plane out of a decision a person made.
  if (choice.settled) return;
  input.setPhase({
    ...choice,
    switchedHostId: choice.previousSwitchedHostId,
    previousSwitchedHostId: null,
    // What we fall back to was settled before the gesture, so the undo lands
    // on a settled phase and this never walks a chain.
    settled: true,
  });
  input.setUnavailableHostId(choice.switchedHostId);
}
