import {
  Folder,
  FolderGit2,
  GitBranch,
  Layers,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement } from "react";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import type {
  EpicMentionEntry,
  MentionPreview,
  WorkspaceEntry,
} from "@/lib/composer/types";
import { dirnameOfPath, mentionPathTree } from "@/lib/path";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";

/**
 * Row-display mapping for @mention suggestion entries: the picker's
 * detail/description text, full preview payload, and icon, derived per
 * entry kind. Extracted out of `providers.tsx` (provider registration +
 * routing) to keep that file focused - `suggestionEntry` there is the only
 * caller.
 */
export const MENU_ICON_CLASS = "size-4 shrink-0 text-muted-foreground";

export function detailForSuggestion(
  entry: WorkspaceEntry | EpicMentionEntry,
): string {
  if (entry.kind === "file" || entry.kind === "folder") {
    return dirnameOfPath(entry.relPath);
  }
  if (entry.kind === "epic-chat") return entry.epicTitle;
  if (entry.kind === "epic-artifact") return entry.epicTitle;
  return "";
}

export function descriptionForSuggestion(
  entry: WorkspaceEntry | EpicMentionEntry,
): string {
  if (entry.kind === "epic-artifact" && entry.description === entry.epicTitle) {
    return "";
  }
  if (entry.kind === "epic-chat" && entry.description === entry.epicTitle) {
    return "";
  }
  return entry.description;
}

export function previewForSuggestion(
  entry: WorkspaceEntry | EpicMentionEntry,
): MentionPreview | null {
  switch (entry.kind) {
    case "file":
    case "folder":
      return {
        kind: "path",
        tree: mentionPathTree(entry.relPath, entry.kind === "file"),
        footer: { text: entry.absolutePath, mono: true },
      };
    case "worktree":
      return {
        kind: "path",
        tree: mentionPathTree(entry.worktreePath, false),
        footer:
          entry.branch === null ? null : { text: entry.branch, mono: false },
      };
    case "git":
      return previewForGitSuggestion(entry);
    case "epic":
      return {
        kind: "text",
        primary: entry.label,
        secondary: null,
        mono: false,
      };
    case "epic-artifact":
    case "epic-chat":
      return {
        kind: "text",
        primary: entry.label,
        secondary: entry.epicTitle,
        mono: false,
      };
  }
}

function previewForGitSuggestion(
  entry: Extract<WorkspaceEntry, { kind: "git" }>,
): MentionPreview | null {
  switch (entry.gitType) {
    case "against_uncommitted_changes":
      return null;
    case "against_branch":
      return {
        kind: "text",
        primary: entry.branchName,
        secondary: null,
        mono: true,
      };
    case "against_commit":
      return {
        kind: "text",
        primary: entry.commitHash,
        secondary: commitSubjectFromLabel(entry.label),
        mono: true,
      };
  }
}

/**
 * The host bakes a commit row's label as `${shortHash} ${subject}` (see
 * `buildGitCommitSuggestion`) with no separate subject field over the wire;
 * strip the leading short-hash token to recover the subject for the preview.
 */
function commitSubjectFromLabel(label: string): string {
  const spaceIndex = label.indexOf(" ");
  return spaceIndex === -1 ? "" : label.slice(spaceIndex + 1);
}

export function iconForSuggestion(
  entry: WorkspaceEntry | EpicMentionEntry,
): ReactElement {
  switch (entry.kind) {
    case "file":
      return <MaterialFileIcon filename={entry.relPath} className="size-4" />;
    case "folder":
      return folderIcon();
    case "worktree":
      return worktreeIcon();
    case "git":
      return gitIcon();
    case "epic":
      return epicIcon();
    case "epic-artifact":
      return artifactIcon(entry.artifactType);
    case "epic-chat":
      return epicNodeIcon("chat");
  }
}

export function folderIcon(): ReactElement {
  return <Folder className={MENU_ICON_CLASS} aria-hidden />;
}

export function gitIcon(): ReactElement {
  return <GitBranch className={MENU_ICON_CLASS} aria-hidden />;
}

export function worktreeIcon(): ReactElement {
  return <FolderGit2 className={MENU_ICON_CLASS} aria-hidden />;
}

export function epicIcon(): ReactElement {
  return <Layers className={MENU_ICON_CLASS} aria-hidden />;
}

export function artifactIcon(kind: EpicArtifactKind): ReactElement {
  return epicNodeIcon(kind);
}

export function epicNodeIcon(kind: "chat" | EpicArtifactKind): ReactElement {
  const Icon: LucideIcon = EPIC_NODE_ICONS[kind];
  return <Icon className={MENU_ICON_CLASS} aria-hidden />;
}
