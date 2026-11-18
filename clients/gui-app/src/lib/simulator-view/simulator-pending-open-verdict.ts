import type {
  SimulatorSession,
  SimulatorState,
} from "@traycer/protocol/host/simulator/schemas";
import type { SimulatorPendingOpen } from "@/stores/epics/simulator-pending-opens-store";

/**
 * What one host's published state says about a pending open:
 *
 * - `session`: a session carries its `requestId`, new or live; the open
 *   worked, whatever its answer still owes. A Watch also reads the viewer's
 *   own person session on the instance it named as its own, because the host
 *   stamps a session with the requestId of the open that LAST returned it.
 * - `opening`: the host is still running it.
 * - `gone`: neither. Only a failure once the host was seen running it, or
 *   once an authoritative read taken after its answer was lost says so:
 *   before that the open may simply not have reached the stream yet.
 */
export type SimulatorPendingOpenVerdict =
  | { readonly kind: "session"; readonly session: SimulatorSession }
  | { readonly kind: "opening" }
  | { readonly kind: "gone" };

export function simulatorPendingOpenVerdict(
  open: SimulatorPendingOpen,
  state: SimulatorState,
  viewerUserId: string | null,
): SimulatorPendingOpenVerdict {
  const session = state.sessions.find(
    (item) => item.requestId === open.requestId,
  );
  if (session !== undefined) return { kind: "session", session };
  if (state.opening?.some((item) => item.requestId === open.requestId))
    return { kind: "opening" };
  // A second Watch of the instance is answered with the first's live session
  // unchanged, and the host re-stamps it with the second's `requestId` -
  // leaving the first's on nothing, though it is this very session the first
  // open produced. A Boot is not read this way: it never named an instance,
  // and Boot another is owed one of its own.
  const watched = open.instanceKey;
  if (watched === null) return { kind: "gone" };
  const own = state.sessions.find(
    (item) =>
      item.instanceKey === watched &&
      item.ownerUserId === viewerUserId &&
      (item.agentId ?? null) === null,
  );
  if (own !== undefined) return { kind: "session", session: own };
  return { kind: "gone" };
}
