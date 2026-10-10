import { useState, type ReactNode } from "react";
import { FileX } from "lucide-react";
import { PdfPreviewLazy } from "@/components/epic-canvas/pdf-preview/pdf-preview-lazy";
import { BlobViewerShell } from "@/components/files/viewers/blob-viewer-shell";
import { ViewerToolbar } from "@/components/files/viewers/viewer-toolbar";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useBlobObjectUrl } from "@/hooks/files/use-blob-object-url";
import type { EpicFileAddress } from "@/hooks/files/use-epic-file-text-query";
import { byteSourceCapBytes } from "@/lib/files/byte-source";

export interface PdfViewerProps {
  readonly hostId: string;
  readonly address: EpicFileAddress;
  /** The tile's actions, drawn at the end of the PDF toolbar. */
  readonly actions: ReactNode;
}

/**
 * A PDF epic file in the workspace pdf.js viewer ("n of m", zoom, search), fed
 * by range reads into a Blob. Its toolbar is the tile's only bar (Viewers): the
 * file's path as the label, the page and search controls, then the tile's
 * actions.
 */
export function PdfViewer(props: PdfViewerProps): ReactNode {
  return (
    <BlobViewerShell
      hostId={props.hostId}
      address={props.address}
      noun="PDF"
      tooLargeDetail={null}
      maxBytes={byteSourceCapBytes("pdf", false)}
      caption={props.address.path}
      actions={props.actions}
    >
      {(blob) => (
        <PdfBlobView
          key={props.address.sha256}
          blob={blob}
          path={props.address.path}
          actions={props.actions}
        />
      )}
    </BlobViewerShell>
  );
}

function PdfBlobView(props: {
  readonly blob: Blob;
  readonly path: string;
  readonly actions: ReactNode;
}): ReactNode {
  const url = useBlobObjectUrl(props.blob);
  const [failed, setFailed] = useState(false);
  if (failed || url === null) {
    return (
      <div className="flex size-full min-h-0 flex-col">
        <ViewerToolbar caption={props.path} actions={props.actions} />
        <div
          role="status"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-ui-sm text-muted-foreground"
        >
          {failed ? (
            <>
              <FileX className="size-5" aria-hidden />
              <p>
                This PDF can&apos;t be shown. Download it to open it elsewhere.
              </p>
            </>
          ) : (
            <AgentSpinningDots
              className={undefined}
              testId="epic-file-loading"
              variant={undefined}
            />
          )}
        </div>
      </div>
    );
  }
  return (
    <PdfPreviewLazy
      url={url}
      fileName={props.path}
      compact={false}
      toolbarActions={props.actions}
      onRenderFailure={() => setFailed(true)}
      onUnavailable={() => setFailed(true)}
    />
  );
}
