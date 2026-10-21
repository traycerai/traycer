import { useCallback } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useSimulatorScreenshotMutation } from "@/hooks/simulator/use-simulator-mutations";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";
import { appLogger } from "@/lib/logger";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

export interface SimulatorScreenshot {
  /** `null` when the host does not offer screenshots. */
  readonly take: (() => void) | null;
  readonly isPending: boolean;
}

/** A file name a save dialog can show: letters, digits and dashes only. */
export function screenshotFileName(simulatorName: string, at: Date): string {
  const slug = simulatorName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${slug.length > 0 ? slug : "simulator"}-${stamp}.png`;
}

export function pngBlobFromBase64(pngBase64: string): Blob {
  const binary = atob(pngBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

/**
 * The host's PNG, saved the way every other "keep these bytes" flow saves
 * (the artifact export, the usage image, a chat image): the shell's own save
 * route, then the saved-file toast with its Open action where the runtime
 * can re-open the file.
 */
export function useSimulatorScreenshot(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly epicId: string;
  readonly simulatorId: string;
  readonly simulatorName: string;
}): SimulatorScreenshot {
  const { client, hostId, epicId, simulatorId, simulatorName } = args;
  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();
  const { mutation, supported } = useSimulatorScreenshotMutation(
    client,
    hostId,
    simulatorId,
  );
  const { mutate, isPending } = mutation;
  const take = useCallback(() => {
    mutate(
      { epicId, simulatorId },
      {
        onSuccess: (response) => {
          void saveBlobToDisk(
            pngBlobFromBase64(response.pngBase64),
            screenshotFileName(simulatorName, new Date()),
            fileSave,
          )
            .then((saved) => {
              if (saved === null) return;
              toastSavedFile(saved, openSaved.mutate, fileSave, "save");
            })
            .catch((cause: unknown) => {
              appLogger.errorSummary(
                "[simulator] screenshot save failed",
                {},
                cause,
              );
              reportableErrorToast("Couldn't save the screenshot", undefined, {
                title: "Couldn't save the screenshot",
                message: null,
                code: null,
                source: "Simulator",
              });
            });
        },
      },
    );
  }, [epicId, fileSave, mutate, openSaved.mutate, simulatorId, simulatorName]);
  return { take: supported ? take : null, isPending };
}
