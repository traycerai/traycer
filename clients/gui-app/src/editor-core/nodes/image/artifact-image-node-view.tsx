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
  const image = useAttachmentBlobSrc(
    attachmentHash.length > 0 ? attachmentHash : null,
    mediaTypeFromSrc(src),
    null,
  );
  let body: ReactNode;
  if (image.status === "loading") {
    body = <AttachmentImageLoading label="Waiting for image sync" />;
  } else if (image.status === "unavailable") {
    body = (
      <AttachmentImageFailure
        alt={alt}
        source={src}
        reason="Image is unavailable"
      />
    );
  } else {
    body = (
      <AttachmentImage
        src={image.src}
        alt={alt}
        mediaType={mediaTypeFromSrc(src)}
        suggestedName={src.split("/").at(-1) ?? null}
      />
    );
  }

  return <NodeViewWrapper contentEditable={false}>{body}</NodeViewWrapper>;
}

function readStringAttr(
  attrs: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = attrs[key];
  return typeof value === "string" ? value : "";
}

function mediaTypeFromSrc(src: string): string {
  const extension = src.split(/[?#]/, 1)[0]?.split(".").at(-1)?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "svg") return "image/svg+xml";
  return "image/png";
}
