import { create } from "zustand";
import type { SimulatorPlatform } from "@traycer/protocol/host/simulator/schemas";
import type { SimulatorTileRef } from "@/stores/epics/canvas/types";

/**
 * The person's own Boot and Watch opens, from the click until the catalog
 * lists the session they produced. Each is the Mobile simulators panel's
 * pending row, keyed by the `requestId` the open was sent with.
 *
 * A pending open learns its `sessionId` from the open's answer or from the
 * sessions stream's session carrying its `requestId`, whichever arrives
 * first; the first of the two also places the tile. It is dropped once the
 * catalog snapshot holds that `sessionId`, or when the open failed: the host
 * answered with an error, or (the answer never arrived) the host stopped
 * listing it in `opening` with no session carrying it.
 */
export interface SimulatorPendingOpen {
  readonly requestId: string;
  readonly epicId: string;
  readonly hostId: string;
  /** The id the open was sent with: a device, or the watched instance. */
  readonly simulatorId: string;
  /** The watched instance; null for Boot and Boot another. */
  readonly instanceKey: string | null;
  readonly name: string;
  readonly platform: SimulatorPlatform;
  readonly version: string;
  readonly sessionId: string | null;
  /** The host listed this open in `opening` at least once. */
  readonly seenOpening: boolean;
  /** The answer never arrived; the sessions stream decides the outcome. */
  readonly answerLost: boolean;
  readonly placed: boolean;
}

interface SimulatorPendingOpensState {
  readonly byRequestId: Readonly<
    Partial<Record<string, SimulatorPendingOpen>>
  >;
}

export const useSimulatorPendingOpensStore = create<SimulatorPendingOpensState>(
  () => ({ byRequestId: {} }),
);

/**
 * Where each open's tile goes, kept beside the store rather than in it: a
 * callback is not state anything renders.
 */
const placeByRequestId = new Map<string, (ref: SimulatorTileRef) => void>();

export function addSimulatorPendingOpen(
  open: SimulatorPendingOpen,
  place: (ref: SimulatorTileRef) => void,
): void {
  placeByRequestId.set(open.requestId, place);
  useSimulatorPendingOpensStore.setState((state) => ({
    byRequestId: { ...state.byRequestId, [open.requestId]: open },
  }));
}

export function updateSimulatorPendingOpen(
  requestId: string,
  patch: Partial<
    Pick<
      SimulatorPendingOpen,
      "sessionId" | "seenOpening" | "answerLost" | "placed"
    >
  >,
): void {
  useSimulatorPendingOpensStore.setState((state) => {
    const current = state.byRequestId[requestId];
    if (current === undefined) return state;
    return {
      byRequestId: { ...state.byRequestId, [requestId]: { ...current, ...patch } },
    };
  });
}

export function removeSimulatorPendingOpen(requestId: string): void {
  placeByRequestId.delete(requestId);
  useSimulatorPendingOpensStore.setState((state) => {
    if (state.byRequestId[requestId] === undefined) return state;
    const { [requestId]: _removed, ...rest } = state.byRequestId;
    return { byRequestId: rest };
  });
}

/**
 * Places the open's tile once: the answer and the stream session race, and
 * whichever arrives second finds it placed.
 */
export function placeSimulatorPendingOpenTile(
  requestId: string,
  ref: SimulatorTileRef,
): void {
  const current =
    useSimulatorPendingOpensStore.getState().byRequestId[requestId];
  if (current === undefined || current.placed) return;
  updateSimulatorPendingOpen(requestId, { placed: true });
  placeByRequestId.get(requestId)?.(ref);
}

export function simulatorPendingOpensForEpic(
  byRequestId: SimulatorPendingOpensState["byRequestId"],
  epicId: string,
): readonly SimulatorPendingOpen[] {
  return Object.values(byRequestId).filter(
    (open): open is SimulatorPendingOpen =>
      open !== undefined && open.epicId === epicId,
  );
}

/** Test seam: forgets every pending open. */
export function resetSimulatorPendingOpensForTests(): void {
  placeByRequestId.clear();
  useSimulatorPendingOpensStore.setState({ byRequestId: {} });
}
