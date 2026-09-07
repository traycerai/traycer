import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { SweepWorktreesDialog } from "@/components/epics/sweep-worktrees-dialog";
import { sweepNeedsHostPicker } from "@/components/epics/sweep-host-model";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";

/** The arms are separate rather than one arm with flags, because they answer to different authorities and only
 * the union makes that unmistakable. */
interface SweepHostChoicePhase {
  readonly kind: "choice";
  /** Latched; only ever rewritten from `null`. */
  readonly openedOnHostId: string | null;
  readonly switchedHostId: string | null;
  /** The target before the pending switch - the one step back is to here. */
  readonly previousSwitchedHostId: string | null;
  /** This is what separates "the host you just picked cannot be dialled" from "the host you have been working on
   * has since gone away". */
  readonly settled: boolean;
}

type SweepFlowPhase =
  | { readonly kind: "closed" }
  | { readonly kind: "pending" }
  | { readonly kind: "surface" }
  | SweepHostChoicePhase;

const CLOSED: SweepFlowPhase = { kind: "closed" };
/** It is a phase rather than a return, because the alternative is a click that produces nothing at all. */
const PENDING: SweepFlowPhase = { kind: "pending" };
const SURFACE: SweepFlowPhase = { kind: "surface" };

interface SweepWorktreesFlowProps {
  /** The Tasks being swept, exactly as `SweepWorktreesDialog` takes them. */
  readonly epicIds: ReadonlyArray<string> | null;
  /** The client this surface already speaks on - History's app-wide follower, the Epic status row's session
   * client. */
  readonly surfaceHostClient: HostClient<HostRpcRegistry> | null;
  readonly surfaceHostId: string | null;
  readonly taskTitle: string | null;
  readonly onOpenChange: (open: boolean) => void;
}

/** An open dialog is re-pointed only by the person in front of it. Three things could otherwise move it, and
 * each is refused here by name. */
export function SweepWorktreesFlow(props: SweepWorktreesFlowProps): ReactNode {
  const { epicIds } = props;
  // Keyed on the selection rather than the array identity, matching the dialog's own retarget rule: re-opening
  // the same Tasks is a new decision, re-rendering with an equal list is not.
  const selectionKey =
    epicIds === null || epicIds.length === 0
      ? null
      : [...new Set(epicIds)].sort().join(",");
  const fleet = useConnectableHostIds();
  const [decidedKey, setDecidedKey] = useState<string | null>(null);
  const [phase, setPhase] = useState<SweepFlowPhase>(CLOSED);
  // It is the chip's inline error, and it is deliberately not a phase arm: the flow is still open on a real
  // host, which is the whole point of the fallback.
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
  // `null` while nothing is pinned resolves the app-wide follower, which this flow then ignores in favour of the
  // surface's own client.
  const pinnedHostClient = useHostClientForHostId(pinnedHostId);
  // While the surface's own client is the answer, this seam is being called with `null` and answers with the
  // app-wide follower.
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

/** A pick that failed does, because the undo returns the target to `openedOnHostId` - adopting there would
 * silently census the window's host under a chip still reading "couldn't reach Studio - choose another host". */
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

/** It must be its own answer rather than a fallthrough. */
type SweepClientSource = "unchosen" | "surface" | "pinned";

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

/** It defers the decision on an unanswered directory - an unanswered one is not an empty one, and deciding
 * against it would hand a multi-host account the single-host path for the one open where it matters. */
function applySelectionChange(input: {
  readonly selectionKey: string | null;
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
    // Guarded on the current phase because `decidedKey` stays behind.
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
    // `null` when the surface cannot name its host - the unchosen state.
    openedOnHostId: input.surfaceHostId,
    switchedHostId: null,
    previousSwitchedHostId: null,
    // The opened host is settled by definition: it is where the surface was
    // already pointed, not something a person just reached for.
    settled: true,
  });
}

/** Handing the confirmation a null client instead paints an empty census - the query gates on readiness, so it
 * never fetches and never reports pending. */
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
  // A target that has already resolved once and has since stopped is not a failed gesture - nobody just reached
  // for it - so there is nothing to undo.
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
