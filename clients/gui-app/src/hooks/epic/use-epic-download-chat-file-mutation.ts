import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ReadChatFileResponse } from "@traycer/protocol/host/epic/chat-file";

import { useHostMutationWithResponseTimeout } from "@/hooks/host/use-host-query";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import type { HostRpcRegistry } from "@/lib/host";
import { CHAT_FILE_READ_RESPONSE_TIMEOUT_MS } from "@/lib/host-rpc-policy/chat-file-read-response-timeout";
import { base64ToBytes } from "@/lib/composer/image-base64";
import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";
import { toastFromHostError } from "@/lib/host-error-toast";
import { epicMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * One chip's download. The name and media type are the NODE's: the response
 * carries the bytes alone, and the node is the one place a file's declared
 * identity lives.
 */
export interface ChatFileDownloadVariables {
  readonly epicId: string;
  readonly chatId: string;
  readonly hash: string;
  readonly fileName: string;
  readonly mediaType: string;
}

const DOWNLOAD_FAILED = "Could not download this file.";

/**
 * `epic.readChatFile`, then the bytes into the shell's save route: the save
 * dialog on desktop, a browser download on the web, the share sheet on the
 * phone.
 *
 * A `missing` answer is not an error: it is left on the mutation's `data` for
 * the chip to draw inline, and nothing is toasted.
 *
 * Without a cloud verdict the read asks for the host's disk alone
 * (`plane: "local-only"`), as the image read does: the cloud leg would spend a
 * bearer this session may no longer be entitled to.
 */
export function useEpicDownloadChatFile(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly chatId: string;
  readonly hash: string;
}): UseMutationResult<
  ReadChatFileResponse,
  HostRpcError,
  ChatFileDownloadVariables
> {
  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();
  return useHostMutationWithResponseTimeout<
    HostRpcRegistry,
    "epic.readChatFile",
    unknown,
    ChatFileDownloadVariables
  >({
    client: input.client,
    method: "epic.readChatFile",
    responseTimeoutMs: CHAT_FILE_READ_RESPONSE_TIMEOUT_MS,
    signalFor: null,
    mapVariables: (variables) => {
      const request = {
        epicId: variables.epicId,
        chatId: variables.chatId,
        hash: variables.hash,
      };
      return authorizesCloudCapability(useAuthStore.getState().status)
        ? request
        : { ...request, plane: "local-only" as const };
    },
    options: {
      mutationKey: epicMutationKeys.downloadChatFile(
        input.hostId,
        input.chatId,
        input.hash,
      ),
      gcTime: 0,
      onSuccess: async (response, variables) => {
        if (!response.ok) return;
        const bytes = base64ToBytes(response.bytesBase64);
        if (bytes === null) {
          toastFromRunnerError(
            new Error("The downloaded file was malformed."),
            DOWNLOAD_FAILED,
          );
          return;
        }
        try {
          const saved = await saveBlobToDisk(
            new Blob([bytes], { type: variables.mediaType }),
            variables.fileName,
            fileSave,
          );
          if (saved === null) return;
          toastSavedFile(
            saved,
            openSaved.mutate,
            fileSave,
            fileSave?.saveRoute === "share" ? "share" : "save",
          );
        } catch (error: unknown) {
          toastFromRunnerError(error, DOWNLOAD_FAILED);
        }
      },
      onError: (error) => {
        toastFromHostError(error, DOWNLOAD_FAILED);
      },
    },
  });
}
