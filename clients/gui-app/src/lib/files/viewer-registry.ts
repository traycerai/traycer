import {
  File,
  FileCode,
  FileText,
  Film,
  Image,
  type LucideIcon,
} from "lucide-react";

/** The viewers an epic file can open in. */
export type EpicFileViewerKind = "html" | "image" | "video" | "pdf";

export interface EpicFileViewerEntry {
  /** `null`: no viewer, so the tile offers Download only. */
  readonly kind: EpicFileViewerKind | null;
  readonly Icon: LucideIcon;
  /** The icon's colour: the chart token the Files panel uses for the kind. */
  readonly iconClassName: string;
}

const HTML_VIEWER: EpicFileViewerEntry = {
  kind: "html",
  Icon: FileCode,
  iconClassName: "text-[var(--term-ansi-yellow)]",
};

const IMAGE_VIEWER: EpicFileViewerEntry = {
  kind: "image",
  Icon: Image,
  iconClassName: "text-[var(--term-ansi-green)]",
};

const VIDEO_VIEWER: EpicFileViewerEntry = {
  kind: "video",
  Icon: Film,
  iconClassName: "text-[var(--term-ansi-red)]",
};

const PDF_VIEWER: EpicFileViewerEntry = {
  kind: "pdf",
  Icon: FileText,
  iconClassName: "text-[var(--term-ansi-red)]",
};

const NO_VIEWER: EpicFileViewerEntry = {
  kind: null,
  Icon: File,
  iconClassName: "text-muted-foreground",
};

const VIEWERS_BY_EXTENSION: Readonly<Record<string, EpicFileViewerEntry>> = {
  html: HTML_VIEWER,
  htm: HTML_VIEWER,
  png: IMAGE_VIEWER,
  jpg: IMAGE_VIEWER,
  jpeg: IMAGE_VIEWER,
  gif: IMAGE_VIEWER,
  webp: IMAGE_VIEWER,
  avif: IMAGE_VIEWER,
  bmp: IMAGE_VIEWER,
  svg: IMAGE_VIEWER,
  mp4: VIDEO_VIEWER,
  webm: VIDEO_VIEWER,
  mov: VIDEO_VIEWER,
  m4v: VIDEO_VIEWER,
  pdf: PDF_VIEWER,
};

/**
 * Picks a file's viewer by its extension. Only the page writer stores a file
 * as `text/html`; a drop-zone `.html` file is served as text, and the host
 * decides what it may reach either way, so the extension only picks the view.
 */
export function epicFileViewer(path: string): EpicFileViewerEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return NO_VIEWER;
  return VIEWERS_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? NO_VIEWER;
}
