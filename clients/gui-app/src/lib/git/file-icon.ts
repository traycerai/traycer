/**
 * Maps file extensions to lucide icons for Git diff file listings.
 * Falls back to File icon for unknown extensions.
 */

import {
  File,
  FileCode,
  FileJson,
  FileText,
  FileType,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// eslint-disable-next-line complexity -- Extension mapping requires exhaustive switch for common file types.
export function fileIconForPath(path: string): LucideIcon {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";

  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "go":
    case "rs":
    case "rb":
    case "java":
    case "cpp":
    case "c":
    case "h":
    case "hpp":
    case "swift":
    case "kt":
      return FileCode;

    case "json":
    case "jsonl":
    case "ndjson":
      return FileJson;

    case "md":
    case "txt":
    case "log":
      return FileText;

    case "css":
    case "scss":
    case "sass":
    case "less":
    case "html":
    case "htm":
    case "xml":
    case "svg":
      return FileType;

    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "bmp":
      return FileImage;

    case "mp4":
    case "webm":
    case "mkv":
    case "mov":
      return FileVideo;

    case "mp3":
    case "wav":
    case "flac":
    case "aac":
      return FileAudio;

    case "zip":
    case "gz":
    case "tar":
    case "7z":
    case "rar":
      return FileArchive;

    default:
      return File;
  }
}
