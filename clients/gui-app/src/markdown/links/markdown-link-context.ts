import { createContext } from "react";

/**
 * A file the user clicked inside rendered markdown.
 *
 * `path` is the raw href the link carried; the host surface decides how to
 * resolve it against its own workspace roots.
 *
 * Links may also carry a trailing `:line[:col]` target parsed off the href
 * (`/path/file.ts:1177` / `:1177:5`); `line`/`col` are `null` when the href has
 * no such suffix. The host surface decides whether to act on them.
 */
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
 * Host-surface policy for file-like markdown links. Global markdown rendering
 * does not guess how to resolve local paths; chat, file previews, and future
 * surfaces each provide their own path semantics here.
 */
export type MarkdownFileLinkHandler = (link: MarkdownFileLink) => boolean;

export interface MarkdownLinkPolicy {
  readonly openFileLink: MarkdownFileLinkHandler;
  readonly supersedePendingFileLink: () => void;
}

export const MarkdownLinkContext = createContext<MarkdownLinkPolicy | null>(
  null,
);
