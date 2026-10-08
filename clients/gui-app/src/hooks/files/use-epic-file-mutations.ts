import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  EpicCancelFetchFileResponse,
  EpicFetchFileResponse,
} from "@traycer/protocol/host/epic/files";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { readFileBlob, readSignedUrl } from "@/lib/files/byte-source";
import { useEpicFileRpc } from "@/lib/files/epic-file-rpc";
import {
  canDownloadToDevice,
  downloadBlobToDevice,
  saveBlobToDisk,
  type SavedFile,
} from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";
import { toastFromHostError } from "@/lib/host-error-toast";
import { isMobileApp } from "@/lib/mobile-app";
import { useOpenLinkIn } from "@/lib/links/open-link";
import { epicFileViewer } from "@/lib/files/viewer-registry";
import { epicFileMutationKeys } from "@/lib/query-keys";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import { invalidateEpicFileReads } from "@/hooks/files/use-epic-file-blob-query";
import { useEpicFileRecord } from "@/hooks/files/use-epic-file-record";
import {
  epicFileTextQueryOptions,
  epicFileUnavailableMessage,
  type EpicFileAddress,
} from "@/hooks/files/use-epic-file-text-query";

function toastEpicFileError(error: Error, fallback: string): void {
  if (error instanceof HostRpcError) {
    toastFromHostError(error, fallback);
    return;
  }
  toast.error(fallback, { description: error.message });
}

/** The last path segment: what a downloaded file is named. */
export function epicFileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Opens a file in the in-app browser on the tile's host (D08). Always in-app:
 * the URL is the host's loopback, which only a browser running on that host
 * can reach.
 */
export function useEpicFileOpenInBrowser(
  address: EpicFileAddress,
): UseMutationResult<void, Error, void> {
  const rpc = useEpicFileRpc();
  const { openLinkIn } = useOpenLinkIn();
  return useMutation<void>({
    mutationKey: epicFileMutationKeys.openInBrowser(),
    mutationFn: async () => {
      const response = await rpc.openFileInBrowser({
        epicId: address.epicId,
        path: address.path,
        sha256: address.sha256,
        via: address.via,
      });
      if (response.kind === "unavailable") {
        throw new Error(epicFileUnavailableMessage(response.reason));
      }
      openLinkIn(response.url, "in-app");
    },
    onError: (error) => {
      toastEpicFileError(error, `Couldn't open ${epicFileName(address.path)}`);
    },
  });
}

const MIB = 1024 * 1024;

/**
 * The most Download holds in memory when it has to read the bytes through the
 * app (an unpublished file, or a shell with no native URL downloader): the
 * Blob, its `arrayBuffer` and the copy handed to the shell all coexist, and a
 * phone holds far less than a desktop.
 */
export function downloadBufferCapBytes(isMobile: boolean): number {
  return (isMobile ? 64 : 512) * MIB;
}

/** How often Download asks whether the host has finished copying the file. */
const COPY_POLL_MS = 2_000;

export interface EpicFileDownloadProgress {
  readonly received: number;
  readonly total: number;
}

export interface EpicFileDownload {
  readonly mutation: UseMutationResult<SavedFile | null, Error, void>;
  /**
   * Bytes read so far; `null` before the first span, while the host is still
   * copying the file, and on the native route (which reports none).
   */
  readonly progress: EpicFileDownloadProgress | null;
  /** Stops the running download; `null` when there is nothing to stop. */
  readonly cancel: (() => void) | null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(new DOMException("Download cancelled", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Saves a file to the device, whatever its preview kind and whether or not its
 * bytes are on the tile's host yet.
 *
 * - An HTML file reuses the text the row or tile already read.
 * - A published file, on a shell with a native downloader, goes by its signed
 *   URL straight to disk: the bytes never pass through the app.
 * - Anything else is read in spans through the tile's host, up to
 *   {@link downloadBufferCapBytes}, with progress and Cancel. A file too big to
 *   mirror is first copied onto the host (`fetchFile`, polled until it answers
 *   `present`). Past the cap the answer is to wait for the upload, which turns
 *   it into the first case.
 */
export function useEpicFileDownload(
  hostId: string,
  address: EpicFileAddress,
): EpicFileDownload {
  const rpc = useEpicFileRpc();
  const queryClient = useQueryClient();
  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();
  const record = useEpicFileRecord(address.path);
  const [progress, setProgress] = useState<EpicFileDownloadProgress | null>(
    null,
  );
  const [controller, setController] = useState<AbortController | null>(null);
  const name = epicFileName(address.path);
  const mediaType =
    record !== null && record.entry.sha256 === address.sha256
      ? record.entry.mediaType
      : "application/octet-stream";
  const fileRequest = {
    epicId: address.epicId,
    path: address.path,
    sha256: address.sha256,
  };

  async function readHtml(): Promise<Blob> {
    const response = await queryClient.fetchQuery(
      epicFileTextQueryOptions(hostId, rpc, address),
    );
    if (response.kind === "unavailable") {
      throw new Error(epicFileUnavailableMessage(response.reason));
    }
    if (response.kind !== "text") {
      throw new Error(`${name} is not a text file`);
    }
    return new Blob([response.text], { type: response.mediaType });
  }

  /** Copies the file onto the tile's host and waits for it to land. */
  async function copyToHost(signal: AbortSignal): Promise<void> {
    let response = await rpc.fetchFile(fileRequest);
    try {
      // Asking again is idempotent while the copy runs - and restarts one that
      // was cancelled elsewhere, which this explicit Download wants anyway.
      while (response.kind === "downloading") {
        await sleep(COPY_POLL_MS, signal);
        response = await rpc.fetchFile(fileRequest);
        signal.throwIfAborted();
      }
    } catch (error) {
      if (signal.aborted) {
        void rpc.cancelFetchFile(fileRequest).catch(() => {});
      }
      throw error;
    }
    if (response.kind === "unavailable") {
      throw new Error(epicFileUnavailableMessage(response.reason));
    }
  }

  async function readCapped(
    signal: AbortSignal,
    published: boolean,
  ): Promise<Blob> {
    const read = () =>
      readFileBlob((request, s) => rpc.readFile(request, s), address, {
        maxBytes: downloadBufferCapBytes(isMobileApp()),
        onProgress: (received, total) => setProgress({ received, total }),
        signal,
      });
    let result = await read();
    if (result.kind === "unavailable" && result.reason === "not-downloaded") {
      await copyToHost(signal);
      result = await read();
    }
    if (result.kind === "unavailable") {
      throw new Error(epicFileUnavailableMessage(result.reason));
    }
    if (result.kind === "too-large") {
      throw new Error(
        published
          ? `${name} is too large to download on this device`
          : "Download available once the upload finishes",
      );
    }
    return result.blob;
  }

  async function download(signal: AbortSignal): Promise<SavedFile | null> {
    if (epicFileViewer(address.path).kind === "html") {
      return saveBlob(await readHtml());
    }
    // A URL read that fails only means there is no URL to use: the spans
    // through the host still work.
    const answer = await readSignedUrl(
      (request, s) => rpc.readFile(request, s),
      address,
      signal,
    ).catch(() => null);
    const downloadUrl = fileSave?.downloadUrl ?? null;
    if (answer !== null && answer.kind === "url" && downloadUrl !== null) {
      // The shell owns the transfer from here; nothing in the app can stop it.
      setController(null);
      return downloadUrl({ url: answer.url, name, type: mediaType });
    }
    const blob = await readCapped(signal, answer?.kind === "url");
    setController(null);
    return saveBlob(blob);
  }

  function saveBlob(blob: Blob): Promise<SavedFile | null> {
    // A shell whose only save route is a share sheet still saves the file
    // (the phone's "Save HTML file"); everywhere else it downloads.
    return canDownloadToDevice(fileSave)
      ? downloadBlobToDevice(blob, name, fileSave)
      : saveBlobToDisk(blob, name, fileSave);
  }

  const mutation = useMutation<SavedFile | null>({
    mutationKey: epicFileMutationKeys.download(),
    mutationFn: async () => {
      const running = new AbortController();
      setProgress(null);
      setController(running);
      try {
        return await download(running.signal);
      } catch (error) {
        // A cancelled download is a download the user dismissed.
        if (running.signal.aborted) return null;
        throw error;
      } finally {
        setController(null);
        setProgress(null);
      }
    },
    onSuccess: (saved) => {
      if (saved === null) return;
      toastSavedFile(
        saved,
        openSaved.mutate,
        fileSave,
        canDownloadToDevice(fileSave) ? "save" : "share",
      );
    },
    onError: (error) => {
      toastEpicFileError(error, `Couldn't download ${name}`);
    },
  });
  return {
    mutation,
    progress,
    cancel: controller === null ? null : () => controller.abort(),
  };
}

/**
 * The "Download" action for a file too big for the eager mirror (the read
 * answered `not-downloaded`): asks the host to copy it over, then reads it
 * again. A copy still running leaves the read `not-downloaded`, and the text
 * query's unavailable recheck picks the file up once it lands.
 */
export function useEpicFileFetch(
  hostId: string,
  address: EpicFileAddress,
): UseMutationResult<EpicFetchFileResponse, Error, void> {
  const rpc = useEpicFileRpc();
  const queryClient = useQueryClient();
  return useMutation<EpicFetchFileResponse>({
    mutationKey: epicFileMutationKeys.fetch(),
    mutationFn: async () => {
      const response = await rpc.fetchFile({
        epicId: address.epicId,
        path: address.path,
        sha256: address.sha256,
      });
      if (response.kind === "unavailable") {
        throw new Error(epicFileUnavailableMessage(response.reason));
      }
      return response;
    },
    onSuccess: () => invalidateEpicFileReads(queryClient, hostId, address),
    onError: (error) => {
      toastEpicFileError(
        error,
        `Couldn't download ${epicFileName(address.path)}`,
      );
    },
  });
}

/**
 * Cancels a copy `useEpicFileFetch` started. The files lane's `localState`
 * drops back to `absent` on its own, which is what the viewer renders from, so
 * there is nothing to invalidate here.
 */
export function useEpicFileCancelFetch(
  address: EpicFileAddress,
): UseMutationResult<EpicCancelFetchFileResponse, Error, void> {
  const rpc = useEpicFileRpc();
  return useMutation<EpicCancelFetchFileResponse>({
    mutationKey: epicFileMutationKeys.cancelFetch(),
    mutationFn: () =>
      rpc.cancelFetchFile({
        epicId: address.epicId,
        path: address.path,
        sha256: address.sha256,
      }),
    onError: (error) => {
      toastEpicFileError(
        error,
        `Couldn't cancel ${epicFileName(address.path)}`,
      );
    },
  });
}
