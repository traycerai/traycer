import type {
  SimulatorSession,
  SimulatorState,
} from "@traycer/protocol/host/simulator/schemas";
import type { SimulatorPendingOpen } from "@/stores/epics/simulator-pending-opens-store";

/**
 * What one host's published state says about a pending open:
 *
 * - `session`: a session carries its `requestId`, new or live; the open
 *   worked, whatever its answer still owes.
 * - `opening`: the host is still running it.
 * - `gone`: neither. Only a failure once the host was seen running it, or
 *   once its answer was lost and the stream has moved on since: before that
 *   the open may simply not have reached the stream yet.
 */
export type SimulatorPendingOpenVerdict =
  | { readonly kind: "session"; readonly session: SimulatorSession }
  | { readonly kind: "opening" }
  | { readonly kind: "gone" };

export function simulatorPendingOpenVerdict(
  open: SimulatorPendingOpen,
  state: SimulatorState,
): SimulatorPendingOpenVerdict {
  const session = state.sessions.find(
    (item) => item.requestId === open.requestId,
  );
  if (session !== undefined) return { kind: "session", session };
  if (state.opening?.some((item) => item.requestId === open.requestId))
    return { kind: "opening" };
  return { kind: "gone" };
}
