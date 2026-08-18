import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * Whether this window's selection kernel has attached and published a snapshot.
 *
 * `useEffectiveHostId()` answers `null` in two unrelated situations, and only
 * this flag tells them apart: `false` means nobody has answered YET - the
 * store's DETACHED default, before `mountSelectionAuthorityBridge` pushes its
 * first kernel snapshot - while `true` alongside a null host is the real ∅ that
 * the projection's doc comment describes (the window-modal case).
 *
 * Any surface that presents a FAILURE on a null effective host must gate on
 * this. The bridge mounts in an effect, and React runs child effects before
 * parent ones, so a consumer that skips the gate reliably renders its failure
 * state once during its own bootstrap, before the authority has spoken.
 */
export function useSelectionAuthorityAttached(): boolean {
  return useSelectionAuthorityStore((state) => state.attached);
}
