import { createContext } from "react";

/** path is the raw href. line/col from a trailing :line[:col] suffix, else null. Host surface resolves both. */
export interface MarkdownFileLink {
  /** The raw href for the link. */
  readonly path: string;
  /** 1-based line parsed off a trailing `:line` suffix, else `null`. */
  readonly line: number | null;
  /** 1-based column parsed off a trailing `:line:col` suffix, else `null`. */
  readonly col: number | null;
  /** Directory refs have no workspace-file preview; surfaces may ignore them. */
  readonly isDirectory: boolean;
}

/**
 * Host-surface file-link policy. Global markdown does not guess local paths.
 */
export type MarkdownFileLinkHandler = (link: MarkdownFileLink) => boolean;

export interface MarkdownLinkPolicy {
  readonly openFileLink: MarkdownFileLinkHandler;
  readonly supersedePendingFileLink: () => void;
}

export const MarkdownLinkContext = createContext<MarkdownLinkPolicy | null>(
  null,
);
