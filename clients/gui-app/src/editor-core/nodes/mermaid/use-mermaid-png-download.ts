import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { svgToPngBlob } from "@/editor-core/nodes/mermaid/mermaid-service";
import { readMermaidPalette } from "@/editor-core/nodes/mermaid/mermaid-theme";
import {
  canDownloadToDevice,
  downloadBlobToDevice,
  hasSeparateDownloadRoute,
  saveBlobToDisk,
  type SavedFile,
} from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import { appLogger } from "@/lib/logger";
import { runnerMutationKeys } from "@/lib/query-keys";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";

export interface UseMermaidPngDownloadParams {
  readonly svg: string;
  readonly enabled: boolean;
}

/** Which route a run took - see `hasSeparateDownloadRoute`. */
export type MermaidPngExportAction = "share" | "download";

export interface UseMermaidPngDownloadResult {
  /** `null` where this device has no download destination at all. */
  readonly downloadMermaidPng: (() => void) | null;
  /** `null` where the shell owns no OS chooser to hand the PNG to. */
  readonly shareMermaidPng: (() => void) | null;
  readonly isDownloading: boolean;
  /** Which control is in flight, so only that one spins. */
  readonly pendingAction: MermaidPngExportAction | null;
}

interface MermaidPngDownloadInput {
  readonly svg: string;
  readonly action: MermaidPngExportAction;
}

export function useMermaidPngDownload(
  params: UseMermaidPngDownloadParams,
): UseMermaidPngDownloadResult {
  const { svg, enabled } = params;
  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();
  const canShare = hasSeparateDownloadRoute(fileSave);
  const canDownload = canDownloadToDevice(fileSave);
  const mutation = useMutation<
    SavedFile | null,
    Error,
    MermaidPngDownloadInput
  >({
    mutationKey: runnerMutationKeys.mermaidPngDownload(),
    mutationFn: async (input) => {
      const palette = readMermaidPalette(document);
      const blob = await svgToPngBlob({
        svg: input.svg,
        backgroundColor: palette.background,
      });
      // `saveBlobToDisk` is the shell's own save route, which on a shell that
      // also owns a chooser-free download IS the share sheet.
      return input.action === "share"
        ? saveBlobToDisk(blob, "mermaid-diagram.png", fileSave)
        : downloadBlobToDevice(blob, "mermaid-diagram.png", fileSave);
    },
    onSuccess: (saved, input) => {
      if (saved !== null) {
        toastSavedFile(
          saved,
          openSaved.mutate,
          fileSave,
          input.action === "share" ? "share" : "save",
        );
      }
    },
    onError: (err, input) => {
      appLogger.errorSummary(`[mermaid] ${input.action} failed`, {}, err);
      const verb = input.action === "share" ? "share" : "download";
      reportableErrorToast(`Failed to ${verb} diagram`, undefined, {
        title: `Could not ${verb} diagram`,
        message: null,
        code: null,
        source: "Mermaid diagram",
      });
    },
  });
  const { mutate, isPending } = mutation;

  const downloadMermaidPng = useCallback(() => {
    if (!enabled || svg.length === 0) return;
    mutate({ svg, action: "download" });
  }, [enabled, mutate, svg]);

  const startShare = useCallback(() => {
    if (!enabled || svg.length === 0) return;
    mutate({ svg, action: "share" });
  }, [enabled, mutate, svg]);

  return {
    downloadMermaidPng: canDownload ? downloadMermaidPng : null,
    shareMermaidPng: canShare ? startShare : null,
    isDownloading: isPending,
    pendingAction: isPending ? mutation.variables.action : null,
  };
}
