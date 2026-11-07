import { FileText, Files, ImageIcon } from "lucide-react";
import type { FileTransferDragOverlayVariant } from "@/lib/files/file-transfer-paths";

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
} satisfies Record<
  FileTransferDragOverlayVariant,
  {
    readonly Icon: typeof ImageIcon;
    readonly title: string;
    readonly subtitle: string;
  }
>;
