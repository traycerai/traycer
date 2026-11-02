import { Download } from "lucide-react";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
import { useHtmlArtifactDownload } from "@/hooks/files/use-html-artifact-download-mutation";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { canDownloadToDevice } from "@/lib/files/save-blob-to-disk";

interface HtmlArtifactDownloadProps {
  readonly source: Extract<SandboxSource, { kind: "artifact" }>;
  readonly title: string;
  readonly hostId: string;
}

interface HtmlArtifactDownloadAction {
  readonly available: boolean;
  readonly label: string;
  readonly pending: boolean;
  readonly start: () => void;
}

function useHtmlArtifactDownloadAction(
  props: HtmlArtifactDownloadProps,
): HtmlArtifactDownloadAction {
  const download = useHtmlArtifactDownload(
    props.hostId,
    props.source.artifactId,
  );
  const fileSave = useFileSaveHost();
  const available = canDownloadToDevice(fileSave);
  return {
    available,
    label: available
      ? "Download ZIP"
      : "Downloads are unavailable on this device",
    pending: download.isPending,
    start: () => download.mutate({ source: props.source, title: props.title }),
  };
}

function DownloadGlyph(props: { readonly pending: boolean }) {
  return props.pending ? (
    <AgentSpinningDots
      className={undefined}
      testId={undefined}
      variant={undefined}
    />
  ) : (
    <Download className="size-4" />
  );
}

export function HtmlArtifactDownloadButton(props: HtmlArtifactDownloadProps) {
  const action = useHtmlArtifactDownloadAction(props);
  const coarsePointer = useCoarsePointer();
  return (
    <TooltipWrapper
      label={action.label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size={coarsePointer ? "icon-touch" : "icon-sm"}
          aria-label={action.label}
          aria-busy={action.pending}
          disabled={!action.available || action.pending}
          onClick={action.start}
        >
          <DownloadGlyph pending={action.pending} />
        </Button>
      </span>
    </TooltipWrapper>
  );
}

/** The same download, as a row of the artifact tile's "More actions" menu. */
export function HtmlArtifactDownloadMenuItem(props: HtmlArtifactDownloadProps) {
  const action = useHtmlArtifactDownloadAction(props);
  return (
    <DropdownMenuItem
      aria-busy={action.pending}
      disabled={!action.available || action.pending}
      onSelect={action.start}
    >
      <DownloadGlyph pending={action.pending} />
      {action.label}
    </DropdownMenuItem>
  );
}
