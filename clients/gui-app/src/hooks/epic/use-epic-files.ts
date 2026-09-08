/**
 * The epic file plane's read seam and its three write verbs, for surfaces
 * bound to a tab's host (`epic-file` tile today, the Files panel next).
 *
 * ## Reads come from the doc, not from an RPC
 *
 * There is no `listFiles` method on purpose (`protocol/host/epic/files.ts`):
 * the manifest is a sibling `Y.Map` on the epic root doc and every client that
 * can render a file already replicates it. So the entry behind a tile is read
 * out of the projected `files` slice, which means a re-capture at the same
 * path, an upload finishing, a delete and a restore all move an open surface
 * with no refetch and no cache to invalidate.
 */
import type { EpicFileEntry } from "@traycer/protocol/persistence/epic/files";
import type {
  CaptureTabScreenshotRequest,
  CaptureTabScreenshotResponse,
  EpicFileTombstoneRequest,
  EpicFileTombstoneResponse,
  OpenEpicFileInBrowserRequest,
  OpenEpicFileInBrowserResponse,
  StartTabRecordingRequest,
  StartTabRecordingResponse,
  StopTabRecordingRequest,
  StopTabRecordingResponse,
} from "@traycer/protocol/host/epic/files";
import type { UseMutationResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEpicStore } from "@/hooks/use-epic-store";
import { toastFromHostError } from "@/lib/host-error-toast";
import { epicMutationKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";
import type { EpicFileRecord } from "@/stores/epics/open-epic/types";

/**
 * The manifest entry keyed by `path`, live or tombstoned.
 *
 * BOTH arms of the slice are searched: the projector keeps tombstoned rows in
 * `deleted` rather than dropping them (D25 - restore is un-tombstoning), and a
 * tile whose file was deleted under it must render "no longer available" with
 * a Restore action, not "no longer listed".
 *
 * Returns the slice's OWN entry reference, never a fresh object: it is a
 * Zustand selector, so allocating here would report a change on every store
 * emit and re-render every open file tile on unrelated epic traffic.
 */
function fileEntryFor(
  state: OpenEpicState,
  path: string,
): EpicFileEntry | null {
  const live = state.files.records.find((record) => record.path === path);
  if (live !== undefined) return live.entry;
  return (
    state.files.deleted.find((record) => record.path === path)?.entry ?? null
  );
}

/**
 * The live manifest entry for one path, or `null` when the epic has no
 * readable entry there (never written, compacted away, or unparsable - the
 * projector drops an unparsable key rather than surfacing it).
 */
export function useEpicFileEntry(path: string): EpicFileEntry | null {
  return useEpicStore((state: OpenEpicState) => fileEntryFor(state, path));
}

/**
 * The live POSTER object of one recording (D14), or `null` when the recording
 * has none yet.
 *
 * A recording is three objects linked by `recordingId`, not one entry with
 * three paths, so the poster is found by scanning for the sibling rather than
 * by deriving `<id>.poster.png` from the clip's own path. That matters twice:
 * the poster is written AFTER the clip on a stop (so an open tile has to pick
 * it up when it lands, which a doc-backed selector does for free), and a
 * derived path would address an entry that may never exist - the fallback if
 * the poster frame could not be grabbed is no poster, not a broken one.
 *
 * `deleted` is deliberately not searched: a tombstoned poster has no bytes
 * (D25), and a `<video>` handed a poster url that answers "unavailable" shows
 * a broken frame where showing none is correct.
 */
export function useEpicRecordingPoster(
  recordingId: string | null,
): EpicFileRecord | null {
  return useEpicStore((state: OpenEpicState) =>
    recordingId === null
      ? null
      : (state.files.records.find(
          (record) =>
            record.entry.recordingId === recordingId &&
            record.entry.kind === "poster",
        ) ?? null),
  );
}

export type EpicFileTombstoneMutation = UseMutationResult<
  EpicFileTombstoneResponse,
  HostRpcError,
  EpicFileTombstoneRequest
>;

/**
 * Tombstone one entry on the TAB's host (D25).
 *
 * No cache to update on success, deliberately: the tombstone lands in the
 * manifest, every participant learns it by observing the doc they already
 * hold, and {@link useEpicFileEntry} re-renders from that. Writing a Query
 * cache here would give the surface a second, racing arrival order for one
 * fact.
 */
export function useEpicDeleteFile(
  epicId: string,
  path: string,
): EpicFileTombstoneMutation {
  const client = useTabHostClient();
  return useHostMutation<HostRpcRegistry, "epic.deleteFile">({
    client,
    method: "epic.deleteFile",
    mapVariables: (variables: EpicFileTombstoneRequest) => variables,
    options: {
      mutationKey: epicMutationKeys.deleteFile(epicId, path),
      onError: (error: HostRpcError) => {
        toastFromHostError(error, "Couldn't delete this file.");
      },
    },
  });
}

/** Un-tombstone one entry (D25 - restore is deletion in the other direction). */
export function useEpicRestoreFile(
  epicId: string,
  path: string,
): EpicFileTombstoneMutation {
  const client = useTabHostClient();
  return useHostMutation<HostRpcRegistry, "epic.restoreFile">({
    client,
    method: "epic.restoreFile",
    mapVariables: (variables: EpicFileTombstoneRequest) => variables,
    options: {
      mutationKey: epicMutationKeys.restoreFile(epicId, path),
      onError: (error: HostRpcError) => {
        toastFromHostError(error, "Couldn't restore this file.");
      },
    },
  });
}

export type EpicOpenFileInBrowserMutation = UseMutationResult<
  OpenEpicFileInBrowserResponse,
  HostRpcError,
  OpenEpicFileInBrowserRequest
>;

/**
 * Ask the tab's host for a loopback url on the epic's own token-scoped static
 * server (D32). The caller opens a BROWSER TILE at it and nothing else: the
 * url resolves only on the answering host's machine, and the bytes are never
 * served from the cloud origin as `text/html`.
 */
export function useEpicOpenFileInBrowser(
  epicId: string,
  path: string,
): EpicOpenFileInBrowserMutation {
  const client = useTabHostClient();
  return useHostMutation<HostRpcRegistry, "epic.openFileInBrowser">({
    client,
    method: "epic.openFileInBrowser",
    mapVariables: (variables: OpenEpicFileInBrowserRequest) => variables,
    options: {
      mutationKey: epicMutationKeys.openFileInBrowser(epicId, path),
      onError: (error: HostRpcError) => {
        toastFromHostError(error, "Couldn't open this file in a browser.");
      },
    },
  });
}

/**
 * The live CLIP object of one recording (D14), found the same way
 * {@link useEpicRecordingPoster} finds its poster and for the same reason: a
 * recording is three entries sharing a `recordingId`, not one entry with three
 * paths, and the clip's own path is minted host-side.
 *
 * This is what gives the tile badge its upload state after `recordingEnded` -
 * `pending` while the object is going up, then `available` / `local-only` /
 * `failed` - straight off the manifest, with no second arrival order.
 */
export function useEpicRecordingClip(
  recordingId: string | null,
): EpicFileRecord | null {
  return useEpicStore((state: OpenEpicState) =>
    recordingId === null
      ? null
      : (state.files.records.find(
          (record) =>
            record.entry.recordingId === recordingId &&
            record.entry.kind === "recording",
        ) ?? null),
  );
}

export type EpicCaptureTabScreenshotMutation = UseMutationResult<
  CaptureTabScreenshotResponse,
  HostRpcError,
  CaptureTabScreenshotRequest
>;

/**
 * One user-initiated screenshot of a browser tab, on the TAB's host (D29).
 *
 * No cache to touch: `save: true` mints a manifest entry, which every surface
 * learns by observing the doc. The response carries the address anyway, so the
 * save toast can offer "Open" without waiting for the entry to replicate.
 */
export function useEpicCaptureTabScreenshot(
  epicId: string,
  tabId: string,
): EpicCaptureTabScreenshotMutation {
  const client = useTabHostClient();
  return useHostMutation<HostRpcRegistry, "epic.captureTabScreenshot">({
    client,
    method: "epic.captureTabScreenshot",
    mapVariables: (variables: CaptureTabScreenshotRequest) => variables,
    options: {
      mutationKey: epicMutationKeys.captureTabScreenshot(epicId, tabId),
      onError: (error: HostRpcError) => {
        toastFromHostError(error, "Couldn't capture this tab.");
      },
    },
  });
}

export type EpicStartTabRecordingMutation = UseMutationResult<
  StartTabRecordingResponse,
  HostRpcError,
  StartTabRecordingRequest
>;

/**
 * Ask the tab's host to start recording it (D20).
 *
 * A REFUSAL is not an error here: every arm of `startTabRecordingRefusalSchema`
 * is a cap or a placement fact the host checked before doing any work (D21), so
 * it arrives as `{ ok: false, reason }` and the caller renders the reason. Only
 * a genuine transport/host failure reaches `onError`.
 */
export function useEpicStartTabRecording(
  epicId: string,
  tabId: string,
): EpicStartTabRecordingMutation {
  const client = useTabHostClient();
  return useHostMutation<HostRpcRegistry, "epic.startTabRecording">({
    client,
    method: "epic.startTabRecording",
    mapVariables: (variables: StartTabRecordingRequest) => variables,
    options: {
      mutationKey: epicMutationKeys.startTabRecording(epicId, tabId),
      onError: (error: HostRpcError) => {
        toastFromHostError(error, "Couldn't start recording this tab.");
      },
    },
  });
}

export type EpicStopTabRecordingMutation = UseMutationResult<
  StopTabRecordingResponse,
  HostRpcError,
  StopTabRecordingRequest
>;

/**
 * Stop one recording by its `recordingId`.
 *
 * Acknowledges the STOP, never the save: finalize (drain, hash, rename,
 * manifest write) runs after the last chunk lands and reports itself on
 * `epic.fileEvents`. `{ stopped: false }` means there was no such active
 * recording, which is what a double-click produces - an ordinary answer.
 */
export function useEpicStopTabRecording(
  epicId: string,
  tabId: string,
): EpicStopTabRecordingMutation {
  const client = useTabHostClient();
  return useHostMutation<HostRpcRegistry, "epic.stopTabRecording">({
    client,
    method: "epic.stopTabRecording",
    mapVariables: (variables: StopTabRecordingRequest) => variables,
    options: {
      mutationKey: epicMutationKeys.stopTabRecording(epicId, tabId),
      onError: (error: HostRpcError) => {
        toastFromHostError(error, "Couldn't stop this recording.");
      },
    },
  });
}
