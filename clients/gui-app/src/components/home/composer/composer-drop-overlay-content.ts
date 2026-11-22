import { FileText, Files, ImageIcon, Paperclip } from "lucide-react";
import { FILE_ATTACHMENT_MAX_BYTES } from "@traycer/protocol/host/drafts/schemas";
import type { FileTransferDragOverlayVariant } from "@/lib/files/file-transfer-paths";
import { formatByteSize } from "@/lib/format-byte-size";

const ATTACHED_FILES_SUBTITLE = `Files up to ${formatByteSize(FILE_ATTACHMENT_MAX_BYTES)}`;

export const FILE_DROP_OVERLAY_CONTENT = {
  images: {
    Icon: ImageIcon,
    title: "Drop image to attach",
    subtitle: "PNG, JPG, GIF up to 5MB",
  },
  paths: {
    Icon: FileText,
    title: "Drop to insert file path",
    subtitle: "Path will be inserted in the message",
  },
  mixed: {
    Icon: Files,
    title: "Drop to attach images and insert file paths",
    subtitle: "Images attach; file paths are inserted",
  },
  files: {
    Icon: Paperclip,
    title: "Drop to attach files",
    subtitle: ATTACHED_FILES_SUBTITLE,
  },
  imagesAndFiles: {
    Icon: Files,
    title: "Drop to attach images and files",
    subtitle: ATTACHED_FILES_SUBTITLE,
  },
} satisfies Record<
  FileTransferDragOverlayVariant,
  {
    readonly Icon: typeof ImageIcon;
    readonly title: string;
    readonly subtitle: string;
  }
>;
