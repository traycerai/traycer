import { Download } from "lucide-react";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
import { useHtmlArtifactDownload } from "@/hooks/files/use-html-artifact-download-mutation";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { canDownloadToDevice } from "@/lib/files/save-blob-to-disk";

export function HtmlArtifactDownloadButton(props: {
  readonly source: Extract<SandboxSource, { kind: "artifact" }>;
  readonly title: string;
  readonly hostId: string;
}) {
  const download = useHtmlArtifactDownload(
    props.hostId,
    props.source.artifactId,
  );
  const fileSave = useFileSaveHost();
  const coarsePointer = useCoarsePointer();
  const available = canDownloadToDevice(fileSave);
  return (
    <TooltipWrapper
      label={
        available ? "Download ZIP" : "Downloads are unavailable on this device"
      }
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size={coarsePointer ? "icon-touch" : "icon-sm"}
        aria-label="Download ZIP"
        aria-busy={download.isPending}
        disabled={!available || download.isPending}
        onClick={() =>
          download.mutate({ source: props.source, title: props.title })
        }
      >
        {download.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : (
          <Download className="size-4" />
        )}
      </Button>
    </TooltipWrapper>
  );
}
