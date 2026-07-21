import {
  Folder,
  FolderGit2,
  GitBranch,
  Layers,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement } from "react";
import { MaterialFileIcon } from "@/components/material-file-icon";
import {
  EPIC_NODE_ICONS,
  TUI_AGENT_HARNESS_LABELS,
} from "@/lib/artifacts/node-display";
import type {
  AgentMentionInterface,
  EpicAgentMentionEntry,
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

/**
 * Interface label for an Agent row. The product axis is
 * **Interface: Chat / Terminal** - both arms are Agents, so this reads as a
 * qualifier on one entity, not as two entity types.
 */
const AGENT_INTERFACE_LABELS: Readonly<Record<AgentMentionInterface, string>> =
  {
    chat: "Chat",
    terminal: "Terminal",
  };

/**
 * Shown when an Agent's runtime has no agent-to-agent inbox at all (Codex /
 * OpenCode Terminal Agents today). The row stays selectable - this only stops
 * the picker from implying the Agent is messageable. Its ABSENCE is not a
 * promise of delivery: see `runtimeSupportsMessageDelivery`, which is the
 * runtime arm of the host's send gate, not full routability.
 */
const REFERENCE_ONLY_LABEL = "Reference only";

/**
 * Secondary context that disambiguates two Agents sharing a title: which
 * interface it uses, which coding agent backs it (Terminal only - a chat's
 * harness label is not statically known in the renderer), and whether its
 * runtime can receive agent-to-agent messages at all.
 */
export function agentEntrySecondaryContext(
  entry: EpicAgentMentionEntry,
): string {
  const parts = [AGENT_INTERFACE_LABELS[entry.agentInterface]];
  if (entry.kind === "epic-terminal-agent") {
    parts.push(TUI_AGENT_HARNESS_LABELS[entry.harnessId]);
  }
  if (!entry.runtimeSupportsMessageDelivery) parts.push(REFERENCE_ONLY_LABEL);
  return parts.join(" · ");
}

function isAgentEntry(
  entry: WorkspaceEntry | EpicMentionEntry,
): entry is EpicAgentMentionEntry {
  return entry.kind === "epic-chat" || entry.kind === "epic-terminal-agent";
}

export function detailForSuggestion(
  entry: WorkspaceEntry | EpicMentionEntry,
): string {
  if (entry.kind === "file" || entry.kind === "folder") {
    return dirnameOfPath(entry.relPath);
  }
  // Agent rows are always current-Task, so the epic title the artifact rows use
  // here carries no signal; interface + capability disambiguate instead.
  if (isAgentEntry(entry)) return agentEntrySecondaryContext(entry);
  if (entry.kind === "epic-artifact") return entry.epicTitle;
  return "";
}

export function descriptionForSuggestion(
  entry: WorkspaceEntry | EpicMentionEntry,
): string {
  if (entry.kind === "epic-artifact" && entry.description === entry.epicTitle) {
    return "";
  }
  if (isAgentEntry(entry) && entry.description === entry.epicTitle) {
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
      return {
        kind: "text",
        primary: entry.label,
        secondary: entry.epicTitle,
        mono: false,
      };
    case "epic-chat":
    case "epic-terminal-agent":
      return {
        kind: "text",
        primary: entry.label,
        secondary: agentEntrySecondaryContext(entry),
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
    case "epic-terminal-agent":
      return epicNodeIcon("terminal-agent");
  }
}

/**
 * Icon for the unified **Agents** mention category. Uses the terminal-agent
 * glyph (a bot) rather than the chat bubble: the category spans both
 * interfaces, so the conversational icon would under-describe it.
 */
export function agentCategoryIcon(): ReactElement {
  return epicNodeIcon("terminal-agent");
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

export function epicNodeIcon(
  kind: "chat" | "terminal-agent" | EpicArtifactKind,
): ReactElement {
  const Icon: LucideIcon = EPIC_NODE_ICONS[kind];
  return <Icon className={MENU_ICON_CLASS} aria-hidden />;
}
