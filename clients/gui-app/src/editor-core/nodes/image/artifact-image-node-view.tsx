import type { ReactNode } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import {
  AttachmentImage,
  AttachmentImageFailure,
  AttachmentImageLoading,
} from "@/components/chat/segments/attachment-image";
import { useAttachmentBlobSrc } from "@/lib/attachments/use-attachment-blob-src";

export function ArtifactImageNodeView(props: NodeViewProps): ReactNode {
  const src = readStringAttr(props.node.attrs, "src");
  const alt = readStringAttr(props.node.attrs, "alt");
  const attachmentHash = readStringAttr(props.node.attrs, "attachmentHash");
  const mediaType = readStringAttr(props.node.attrs, "mediaType");
  const image = useAttachmentBlobSrc(
    attachmentHash.length > 0 ? attachmentHash : null,
    mediaType,
    null,
  );
  let body: ReactNode;
  if (image.status === "loading") {
    body = <AttachmentImageLoading label="Waiting for image sync" fullWidth />;
  } else if (image.status === "unavailable") {
    body = <AttachmentImageFailure alt={alt} reason="Image is unavailable" />;
  } else {
    body = (
      <AttachmentImage
        src={image.src}
        alt={alt}
        mediaType={mediaType}
        suggestedName={src.split("/").at(-1) ?? null}
        fullWidth
      />
    );
  }

  return (
    <NodeViewWrapper contentEditable={false} className="not-prose max-w-full">
      {body}
    </NodeViewWrapper>
  );
}

function readStringAttr(
  attrs: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = attrs[key];
  return typeof value === "string" ? value : "";
}
