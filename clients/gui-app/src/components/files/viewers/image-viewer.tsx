import { useState, type ReactNode } from "react";
import { ImageOff } from "lucide-react";
import { assetMediaTypeSchemaV12 } from "@traycer/protocol/host/asset-stream-schemas";
import { ImagePreview } from "@/components/epic-canvas/image-preview/image-preview";
import { DEFAULT_ANIMATION_MS } from "@/components/epic-canvas/image-preview/image-preview-transform";
import { BlobViewerShell } from "@/components/files/viewers/blob-viewer-shell";
import { ViewerToolbar } from "@/components/files/viewers/viewer-toolbar";
import { useBlobObjectUrl } from "@/hooks/files/use-blob-object-url";
import { epicFileName } from "@/hooks/files/use-epic-file-mutations";
import type { EpicFileAddress } from "@/hooks/files/use-epic-file-text-query";
import type { FileAssetMeta } from "@/hooks/assets/use-file-asset";
import { byteSourceCapBytes } from "@/lib/files/byte-source";
import { isMobileApp } from "@/lib/mobile-app";

export interface ImageViewerProps {
  readonly hostId: string;
  readonly address: EpicFileAddress;
  /** The tile's actions, drawn at the end of the image toolbar. */
  readonly actions: ReactNode;
}

/**
 * An image epic file in the workspace image viewer (zoom, Fit, copy), fed by
 * range reads into a Blob so it renders on a remote client with the cloud
 * offline (§2.4). Its toolbar is the tile's only bar (Viewers): size and
 * decoded dimensions, zoom, copy, then the tile's actions.
 */
export function ImageViewer(props: ImageViewerProps): ReactNode {
  const name = epicFileName(props.address.path);
  return (
    <BlobViewerShell
      hostId={props.hostId}
      address={props.address}
      noun="image"
      tooLargeDetail={null}
      maxBytes={byteSourceCapBytes("image", isMobileApp())}
      caption={name}
      actions={props.actions}
    >
      {(blob) => (
        <ImageBlobView
          key={props.address.sha256}
          blob={blob}
          name={name}
          actions={props.actions}
        />
      )}
    </BlobViewerShell>
  );
}

function ImageBlobView(props: {
  readonly blob: Blob;
  readonly name: string;
  readonly actions: ReactNode;
}): ReactNode {
  const url = useBlobObjectUrl(props.blob);
  const [decodeFailed, setDecodeFailed] = useState(false);
  if (decodeFailed) {
    return (
      <div className="flex size-full min-h-0 flex-col">
        <ViewerToolbar caption={props.name} actions={props.actions} />
        <div
          role="status"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-ui-sm text-muted-foreground"
        >
          <ImageOff className="size-5" aria-hidden />
          <p>This image can&apos;t be shown.</p>
        </div>
      </div>
    );
  }
  const mediaType = assetMediaTypeSchemaV12.safeParse(props.blob.type);
  // Dimensions come from the decoded `<img>`, which ImagePreview reads itself.
  const meta: FileAssetMeta | null = mediaType.success
    ? {
        mediaType: mediaType.data,
        sizeBytes: props.blob.size,
        width: null,
        height: null,
      }
    : null;
  return (
    <ImagePreview
      status={url === null ? "loading" : "ready"}
      url={url}
      meta={meta}
      servedFromCache={false}
      fileName={props.name}
      compact={false}
      gesturesEnabled
      animationMs={DEFAULT_ANIMATION_MS}
      transformRef={null}
      onTransformChange={null}
      doubleClickOverride={null}
      onDecodeError={() => setDecodeFailed(true)}
      toolbarActions={props.actions}
    />
  );
}
