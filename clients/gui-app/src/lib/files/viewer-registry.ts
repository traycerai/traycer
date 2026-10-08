import { File, FileCode, type LucideIcon } from "lucide-react";

/**
 * The viewers an epic file can open in. Pages and other HTML today; image,
 * video and PDF join with their viewers.
 */
export type EpicFileViewerKind = "html";

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

const NO_VIEWER: EpicFileViewerEntry = {
  kind: null,
  Icon: File,
  iconClassName: "text-muted-foreground",
};

const VIEWERS_BY_EXTENSION: Readonly<Record<string, EpicFileViewerEntry>> = {
  html: HTML_VIEWER,
  htm: HTML_VIEWER,
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
