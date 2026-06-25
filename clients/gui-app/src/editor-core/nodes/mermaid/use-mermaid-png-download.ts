import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { svgToPngBlob } from "@/editor-core/nodes/mermaid/mermaid-service";
import { readMermaidPalette } from "@/editor-core/nodes/mermaid/mermaid-theme";
import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import { runnerMutationKeys } from "@/lib/query-keys";

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
  const { mutate, isPending } = useMutation<
    string | null,
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
      return saveBlobToDisk(blob, "mermaid-diagram.png");
    },
    onSuccess: (saved) => {
      if (saved !== null) {
        toast.success(`Saved ${saved}`);
      }
    },
    onError: (err) => {
      console.error("[mermaid] download failed", err);
      toast.error("Failed to download diagram");
    },
  });

  const downloadMermaidPng = useCallback(() => {
    if (!enabled || svg.length === 0) return;
    mutate({ svg });
  }, [enabled, mutate, svg]);

  return { downloadMermaidPng, isDownloading: isPending };
}
