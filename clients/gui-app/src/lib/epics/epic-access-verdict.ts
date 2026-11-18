import type { EpicDeletedAttribution } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { isUnavailableEpicCode } from "@/lib/epics/unavailable-epic";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

export type DeadEpicReason =
  | {
      readonly kind: "deleted";
      readonly attribution: EpicDeletedAttribution | null;
      readonly title: string | null;
    }
  | { readonly kind: "revoked" }
  | { readonly kind: "unavailable" };

export function deadEpicReason(state: OpenEpicState): DeadEpicReason | null {
  if (state.epicDeleted !== null) {
    return { kind: "deleted", attribution: state.epicDeleted, title: null };
  }
  if (state.accessLost) {
    return { kind: "revoked" };
  }
  if (
    state.snapshotFetchError !== null &&
    isUnavailableEpicCode(state.snapshotFetchError.code)
  ) {
    // The host could not return a live room on (re)open. This surfaces a
    // delete OR a revoke indistinguishably, so the cause is left neutral.
    return { kind: "unavailable" };
  }
  return null;
}

/**
 * A snapshot an artifact reader must not be admitted to. A tab keeps its own
 * FORBIDDEN recovery (the coordinator's re-grant watcher); a reader has none,
 * so FORBIDDEN withdraws it too, as does a terminal UNAUTHORIZED (the stream
 * gave up on the credential). Reconnecting sets no error and stays admitted.
 */
export function readerAccessDenied(state: OpenEpicState): boolean {
  return (
    deadEpicReason(state) !== null ||
    state.snapshotFetchError?.code === "FORBIDDEN" ||
    state.snapshotFetchError?.code === "UNAUTHORIZED"
  );
}
