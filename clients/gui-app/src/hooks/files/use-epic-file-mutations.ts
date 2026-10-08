import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { EpicFetchFileResponse } from "@traycer/protocol/host/epic/files";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useEpicFileRpc } from "@/lib/files/epic-file-rpc";
import {
  canDownloadToDevice,
  downloadBlobToDevice,
  saveBlobToDisk,
  type SavedFile,
} from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";
import { toastFromHostError } from "@/lib/host-error-toast";
import { useOpenLinkIn } from "@/lib/links/open-link";
import { epicFileMutationKeys } from "@/lib/query-keys";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
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

/**
 * Saves a text file (a page's `.html`) to the device. Reuses the bytes the
 * row or tile already read, so a download never fetches them twice.
 */
export function useEpicFileDownload(
  hostId: string,
  address: EpicFileAddress,
): UseMutationResult<SavedFile | null, Error, void> {
  const rpc = useEpicFileRpc();
  const queryClient = useQueryClient();
  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();
  const name = epicFileName(address.path);
  return useMutation<SavedFile | null>({
    mutationKey: epicFileMutationKeys.download(),
    mutationFn: async () => {
      const response = await queryClient.fetchQuery(
        epicFileTextQueryOptions(hostId, rpc, address),
      );
      if (response.kind === "unavailable") {
        throw new Error(epicFileUnavailableMessage(response.reason));
      }
      if (response.kind !== "text") {
        throw new Error(`${name} is not a text file`);
      }
      const blob = new Blob([response.text], { type: response.mediaType });
      // A shell whose only save route is a share sheet still saves the file
      // (the phone's "Save HTML file"); everywhere else it downloads.
      return canDownloadToDevice(fileSave)
        ? downloadBlobToDevice(blob, name, fileSave)
        : saveBlobToDisk(blob, name, fileSave);
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
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: epicFileTextQueryOptions(hostId, rpc, address).queryKey,
      }),
    onError: (error) => {
      toastEpicFileError(
        error,
        `Couldn't download ${epicFileName(address.path)}`,
      );
    },
  });
}
