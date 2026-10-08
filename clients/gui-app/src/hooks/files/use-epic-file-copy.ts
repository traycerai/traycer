import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateEpicFileReads } from "@/hooks/files/use-epic-file-blob-query";
import {
  useEpicFileCancelFetch,
  useEpicFileFetch,
} from "@/hooks/files/use-epic-file-mutations";
import { useEpicFileLocalState } from "@/hooks/files/use-epic-file-record";
import type { EpicFileAddress } from "@/hooks/files/use-epic-file-text-query";

/** How often a copy this tile started is re-checked when the lane is silent. */
const COPY_RECHECK_MS = 2_000;

export interface EpicFileCopyProgress {
  readonly received: number;
  readonly total: number;
}

export interface EpicFileCopy {
  /** The tile's host is copying the file, as far as this tile can tell. */
  readonly copying: boolean;
  /** Bytes so far; `null` where the files lane does not speak for the host. */
  readonly progress: EpicFileCopyProgress | null;
  readonly start: () => void;
  readonly startPending: boolean;
  readonly cancel: () => void;
  readonly cancelPending: boolean;
}

/**
 * The "Download N MB" copy of a file too big for the eager mirror onto the
 * tile's host, for the viewers' not-downloaded state.
 *
 * Where the files lane speaks for the tile's host it is the truth: its progress
 * shows, and the reads go again the moment it says `present`. Where it does not
 * (the canvas is served by another host), the tile host's own answers are: a
 * `fetchFile` that said `downloading` means copying, and the reads are asked
 * again on that host until they stop saying `not-downloaded` - which unmounts
 * the caller.
 *
 * `failedAt` is when the caller's read last answered `failed` (`null` when it
 * did not). A `fetchFile` that re-runs a failed carriage answers `downloading`
 * whatever happens next, so a read still saying `failed` a recheck after the
 * host took the copy means it failed again: the copy ends and Retry is back.
 */
export function useEpicFileCopy(
  hostId: string,
  address: EpicFileAddress,
  failedAt: number | null,
): EpicFileCopy {
  const queryClient = useQueryClient();
  const local = useEpicFileLocalState(hostId, address);
  const fetchFile = useEpicFileFetch(hostId, address);
  const cancelFetch = useEpicFileCancelFetch(address);
  const { path, sha256 } = address;

  const state = local?.kind ?? null;
  const previous = useRef(state);
  useEffect(() => {
    const was = previous.current;
    previous.current = state;
    if (state === "present" && was !== "present" && was !== null) {
      void invalidateEpicFileReads(queryClient, hostId, { path, sha256 });
    }
  }, [state, queryClient, hostId, path, sha256]);

  const accepted = fetchFile.data?.kind === "downloading";
  const acceptedAt = useRef<number | null>(null);
  useEffect(() => {
    acceptedAt.current = accepted ? Date.now() : null;
  }, [accepted]);
  const { reset } = fetchFile;
  useEffect(() => {
    const since = acceptedAt.current;
    if (failedAt === null || since === null) return;
    // The read right after the accept can still say `failed`; only a
    // recheck's answer speaks for the copy.
    if (failedAt < since + COPY_RECHECK_MS) return;
    acceptedAt.current = null;
    reset();
  }, [failedAt, reset]);

  const recheck = local === null && accepted;
  useEffect(() => {
    if (!recheck) return;
    const timer = window.setInterval(() => {
      void invalidateEpicFileReads(queryClient, hostId, { path, sha256 });
    }, COPY_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [recheck, queryClient, hostId, path, sha256]);

  const progress =
    local !== null && local.kind === "downloading"
      ? { received: local.received, total: local.total }
      : null;
  return {
    copying: progress !== null || accepted,
    progress,
    start: () => fetchFile.mutate(),
    startPending: fetchFile.isPending,
    cancel: () => {
      // The answer that said "downloading" is stale from here on.
      fetchFile.reset();
      cancelFetch.mutate();
    },
    cancelPending: cancelFetch.isPending,
  };
}
