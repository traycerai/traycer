import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { svgToPngBlob } from "@/editor-core/nodes/mermaid/mermaid-service";
import { readMermaidPalette } from "@/editor-core/nodes/mermaid/mermaid-theme";
import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";

export interface UseMermaidPngDownloadParams {
  readonly svg: string;
  readonly enabled: boolean;
}

export interface UseMermaidPngDownloadResult {
  readonly downloadMermaidPng: () => void;
  readonly isDownloading: boolean;
}

export function useMermaidPngDownload(
  params: UseMermaidPngDownloadParams,
): UseMermaidPngDownloadResult {
  const { svg, enabled } = params;
  const inFlightRef = useRef(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadMermaidPng = useCallback(() => {
    if (!enabled || svg.length === 0 || inFlightRef.current) return;

    inFlightRef.current = true;
    setIsDownloading(true);
    void (async (): Promise<void> => {
      try {
        const palette = readMermaidPalette(document);
        const blob = await svgToPngBlob({
          svg,
          backgroundColor: palette.background,
        });
        const saved = await saveBlobToDisk(blob, "mermaid-diagram.png");
        if (saved !== null) {
          toast.success(`Saved ${saved}`);
        }
      } catch (err) {
        console.error("[mermaid] download failed", err);
        toast.error("Failed to download diagram");
      } finally {
        inFlightRef.current = false;
        setIsDownloading(false);
      }
    })();
  }, [enabled, svg]);

  return { downloadMermaidPng, isDownloading };
}
