import { File, FileArchive, FileMusic, FilePlay, FileText } from "lucide-react";

import type { FileAttachmentFamily } from "@/lib/composer/file-attachments";

/** The icon a file chip shows, in the composer and in the transcript alike. */
export function FileAttachmentIcon(props: {
  readonly family: FileAttachmentFamily;
  readonly className: string;
}) {
  const { family, className } = props;
  switch (family) {
    case "video":
      return <FilePlay className={className} aria-hidden />;
    case "audio":
      return <FileMusic className={className} aria-hidden />;
    case "pdf":
      return <FileText className={className} aria-hidden />;
    case "archive":
      return <FileArchive className={className} aria-hidden />;
    case "other":
      return <File className={className} aria-hidden />;
  }
}
