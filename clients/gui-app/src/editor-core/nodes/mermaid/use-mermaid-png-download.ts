import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { svgToPngBlob } from "@/editor-core/nodes/mermaid/mermaid-service";
import { readMermaidPalette } from "@/editor-core/nodes/mermaid/mermaid-theme";
import { saveBlobToDisk, type SavedFile } from "@/lib/files/save-blob-to-disk";
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

export interface UseMermaidPngDownloadResult {
  readonly downloadMermaidPng: () => void;
  readonly isDownloading: boolean;
}

interface MermaidPngDownloadInput {
  readonly svg: string;
}

export function useMermaidPngDownload(
  params: UseMermaidPngDownloadParams,
): UseMermaidPngDownloadResult {
  const { svg, enabled } = params;
  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();
  const { mutate, isPending } = useMutation<
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
      return saveBlobToDisk(blob, "mermaid-diagram.png", fileSave);
    },
    onSuccess: (saved) => {
      if (saved !== null) {
        toastSavedFile(saved, openSaved.mutate, fileSave);
      }
    },
    onError: (err) => {
      appLogger.errorSummary("[mermaid] download failed", {}, err);
      reportableErrorToast("Failed to download diagram", undefined, {
        title: "Could not download diagram",
        message: null,
        code: null,
        source: "Mermaid diagram",
      });
    },
  });

  const downloadMermaidPng = useCallback(() => {
    if (!enabled || svg.length === 0) return;
    mutate({ svg });
  }, [enabled, mutate, svg]);

  return { downloadMermaidPng, isDownloading: isPending };
}
