import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { SweepWorktreesDialog } from "@/components/epics/sweep-worktrees-dialog";
import { SweepHostPickerDialog } from "@/components/epics/sweep-host-picker-dialog";
import { sweepNeedsHostPicker } from "@/components/epics/sweep-host-model";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";

/**
 * Where a Sweep is in the two-step "which host, then which worktrees".
 *
 * `direct` and `picked` are separate arms of a UNION rather than one arm with
 * a nullable host, because they are answers to different questions and only
 * the union makes that unmistakable: `direct` says nobody was asked (there was
 * one usable host, so the surface's own client is the answer, exactly as
 * before multi-host Sweep existed), while `picked` says a person named a
 * machine and the flow must resolve THAT id.
 */
type SweepFlowPhase =
  | { readonly kind: "closed" }
  | { readonly kind: "picking" }
  | { readonly kind: "picked"; readonly hostId: string }
  | { readonly kind: "direct" };

const CLOSED: SweepFlowPhase = { kind: "closed" };
const PICKING: SweepFlowPhase = { kind: "picking" };
const DIRECT: SweepFlowPhase = { kind: "direct" };

interface SweepWorktreesFlowProps {
  /**
   * The Tasks being swept, exactly as `SweepWorktreesDialog` takes them.
   * `null` (or empty) keeps the whole flow closed.
   */
  readonly epicIds: ReadonlyArray<string> | null;
  /**
   * The client this surface already speaks on - History's app-wide follower,
   * the Epic status row's session client. It is what a single-host install
   * sweeps with, unchanged and un-rerouted: the picker never appears there, so
   * that path is byte-for-byte what it was.
   */
  readonly surfaceHostClient: HostClient<HostRpcRegistry> | null;
  /** The host id behind `surfaceHostClient` — the picker's marked default. */
  readonly surfaceHostId: string | null;
  /**
   * Hosts the selected Task(s)' node records name, for the picker's badges.
   * Derived client-side from records the surface already holds; an empty set
   * is legal and simply badges nothing.
   */
  readonly occupiedHostIds: ReadonlySet<string>;
  readonly taskTitle: string | null;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * Sweep, end to end: pick a host when there is a choice to make, then run the
 * existing confirmation against that host.
 *
 * The confirmation dialog, its candidates query and the sweep mutation are
 * untouched by this - they already take a caller-resolved client, and this is
 * simply a caller that can resolve more than one. Everything Sweep's safety
 * rests on is therefore preserved by construction rather than by care: the
 * census is still the dialog's own cheap walk, the authorization is still its
 * forced act-time proof, and the swept `hostId` is still frozen from that
 * proof.
 *
 * **A dialog that is open is never re-pointed.** The host decision is LATCHED
 * the moment a Sweep opens and only ever revisited when the selection itself
 * changes. Deriving it live would have been the same code with a fleet-shaped
 * hazard in it: a host dying mid-confirmation would collapse the fleet to one
 * usable machine, and the open dialog - already showing another host's proven
 * rows - would silently receive a different client.
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

  // The React-recommended "adjust state during render" idiom, as used by the
  // dialog below for its own retargeting.
  if (selectionKey !== decidedKey) {
    if (selectionKey === null) {
      setDecidedKey(null);
      setPhase(CLOSED);
    } else if (fleet.resolved) {
      // Deliberately gated on `resolved`. An unanswered directory is not an
      // empty one, and treating it as a one-host fleet would hand a multi-host
      // account the single-host path for the one open where it matters.
      setDecidedKey(selectionKey);
      setPhase(sweepNeedsHostPicker(fleet.hostIds) ? PICKING : DIRECT);
    }
  }

  const pickedHostId = phase.kind === "picked" ? phase.hostId : null;
  // The sanctioned seam, given the id the person chose. `null` while nothing
  // is picked resolves the app-wide follower, which this flow then ignores in
  // favour of the surface's own client - the two are the same object on
  // History and deliberately are not inside an Epic session.
  const pickedHostClient = useHostClientForHostId(pickedHostId);
  const sweeping = phase.kind === "direct" || phase.kind === "picked";

  return (
    <>
      {phase.kind === "picking" || phase.kind === "picked" ? (
        <SweepHostPickerDialog
          open={phase.kind === "picking"}
          taskCount={epicIds?.length ?? 0}
          taskTitle={props.taskTitle}
          occupiedHostIds={props.occupiedHostIds}
          defaultHostId={props.surfaceHostId}
          onPick={(hostId) => {
            setPhase({ kind: "picked", hostId });
          }}
          onOpenChange={(open) => {
            if (!open) props.onOpenChange(false);
          }}
        />
      ) : null}
      <SweepWorktreesDialog
        epicIds={sweeping ? epicIds : null}
        hostClient={
          pickedHostId === null ? props.surfaceHostClient : pickedHostClient
        }
        taskTitle={props.taskTitle}
        onOpenChange={props.onOpenChange}
      />
    </>
  );
}
