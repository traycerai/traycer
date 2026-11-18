import { create } from "zustand";
import type { EpicCreateRefusal } from "@traycer/protocol/host/epic/unary-schemas";

/**
 * The local-store refusal currently offered a repair, or `null`.
 *
 * A store rather than component state because the two ends sit on opposite
 * sides of React. The refusal arrives in a MUTATION CALLBACK - `epic.create`
 * answers it as data, not as a throw - which has no component context and
 * cannot call `useHostSupportsMethod`; the repair itself needs both that gate
 * and a destructive confirmation, so it has to be a mounted component. This is
 * the handoff between them, and it carries the host so neither end has to
 * re-derive one.
 *
 * `hostId` is the PLACEMENT host the create was dispatched to, taken from the
 * dispatching client. It is not the window's effective host and the two differ
 * whenever the composer is pinned - repairing the wrong machine would leave the
 * refusing store untouched and report success.
 */
export interface LocalStoreRepairRequest {
  readonly hostId: string;
  readonly refusal: EpicCreateRefusal;
}

interface LocalStoreRepairState {
  readonly pending: LocalStoreRepairRequest | null;
}

export const useLocalStoreRepairStore = create<LocalStoreRepairState>(() => ({
  pending: null,
}));

/**
 * Offer the repair for a refusal.
 *
 * Called from the create mutation's success path. Last write wins: a second
 * refused create replaces the first, because the dialog shows one host's
 * refusal and the newer one is the one the user just provoked.
 */
export function openLocalStoreRepair(request: LocalStoreRepairRequest): void {
  useLocalStoreRepairStore.setState({ pending: request });
}

export function closeLocalStoreRepair(): void {
  useLocalStoreRepairStore.setState({ pending: null });
}
