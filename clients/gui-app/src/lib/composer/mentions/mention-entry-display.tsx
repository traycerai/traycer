import {
  Files,
  Folder,
  FolderGit2,
  GitBranch,
  Globe2,
  Layers,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement } from "react";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { BrowserFavicon } from "@/components/epic-canvas/browser-favicon";
import { browserTabFaviconUrl } from "@/lib/browser-view/browser-tab-display";
import {
  EPIC_NODE_ICONS,
  TUI_AGENT_HARNESS_LABELS,
} from "@/lib/artifacts/node-display";
import type {
  AgentMentionInterface,
  BrowserTabMentionEntry,
  EpicAgentMentionEntry,
  MentionPreview,
  MentionSuggestionEntry,
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

/**
 * The menu ROW's trailing text for an Agent, as opposed to the preview
 * panel's `agentEntrySecondaryContext`: no interface label ("Chat",
 * "Terminal") - the row's trailing slot shows the Agent's last-activity
 * time, which is what helps pick between same-named rows - while the
 * harness name and the reference-only marker disambiguate.
 */
function agentEntryRowDetail(entry: EpicAgentMentionEntry): string {
  const parts: string[] = [];
  if (entry.kind === "epic-terminal-agent") {
    parts.push(TUI_AGENT_HARNESS_LABELS[entry.harnessId]);
  }
  if (!entry.runtimeSupportsMessageDelivery) parts.push(REFERENCE_ONLY_LABEL);
  return parts.join(" · ");
}

function isAgentEntry(
  entry: MentionSuggestionEntry,
): entry is EpicAgentMentionEntry {
  return entry.kind === "epic-chat" || entry.kind === "epic-terminal-agent";
}

export function detailForSuggestion(entry: MentionSuggestionEntry): string {
  if (entry.kind === "file" || entry.kind === "folder") {
    return dirnameOfPath(entry.relPath);
  }
  // Agent rows are always current-Task, so the epic title the artifact rows use
  // here carries no signal; harness + capability disambiguate, and the row
  // renders its last-activity time as a separate trailing element.
  if (isAgentEntry(entry)) return agentEntryRowDetail(entry);
  // Two shells started in the same Task routinely share a title; the working
  // directory is what tells them apart.
  if (entry.kind === "epic-terminal") return entry.cwd;
  if (entry.kind === "epic-artifact") return entry.epicTitle;
  // The row's trailing subtitle for a browser tab is its url, per the design.
  if (entry.kind === "browser-tab") return entry.url;
  return "";
}

export function descriptionForSuggestion(
  entry: MentionSuggestionEntry,
): string {
  if (entry.kind === "epic-artifact" && entry.description === entry.epicTitle) {
    return "";
  }
  if (isAgentEntry(entry) && entry.description === entry.epicTitle) {
    return "";
  }
  // A browser tab carries no separate `description` field - the row's detail
  // slot already shows the url (see `detailForSuggestion`), so the picker's
  // description slot stays empty rather than repeating it.
  if (entry.kind === "browser-tab") return "";
  return entry.description;
}

export function previewForSuggestion(
  entry: MentionSuggestionEntry,
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
    case "epic-terminal":
      // The title heads the row already; the panel spends its space on the
      // full working directory, which the row can only show truncated.
      return {
        kind: "path",
        tree: mentionPathTree(entry.cwd, false),
        footer: null,
      };
    case "browser-tab":
      return {
        kind: "text",
        primary: entry.label,
        secondary: entry.url,
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

export function iconForSuggestion(entry: MentionSuggestionEntry): ReactElement {
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
    case "epic-terminal":
      return epicNodeIcon("terminal");
    case "browser-tab":
      return browserTabRowIcon(entry);
  }
}

/**
 * Live favicon for a browser-tab row - `useMaybeBrowserSessionsContext()` is
 * not needed here (unlike the composer chip's decorator): the entry is
 * already sourced from that same live context, so its `url` is current for
 * as long as the row is on screen. Falls back to `Globe2` when the tab has
 * no resolvable http(s) favicon or the image fails to load.
 */
function browserTabRowIcon(entry: BrowserTabMentionEntry): ReactElement {
  return (
    <BrowserFavicon
      faviconUrl={browserTabFaviconUrl(entry.url)}
      isolated={false}
      className={MENU_ICON_CLASS}
    />
  );
}

/**
 * Icon for the unified **Agents** mention category. Uses the terminal-agent
 * glyph (a bot) rather than the chat bubble: the category spans both
 * interfaces, so the conversational icon would under-describe it.
 */
export function agentCategoryIcon(): ReactElement {
  return epicNodeIcon("terminal-agent");
}

/** Icon for the **Terminals** mention category and its rows. */
export function terminalCategoryIcon(): ReactElement {
  return epicNodeIcon("terminal");
}

/** Icon for the **Browser** mention category itself (not its rows, which favicon). */
export function browserTabCategoryIcon(): ReactElement {
  return <Globe2 className={MENU_ICON_CLASS} aria-hidden />;
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

export function artifactsIcon(): ReactElement {
  return <Files className={MENU_ICON_CLASS} aria-hidden />;
}

export function epicNodeIcon(
  kind: "chat" | "terminal-agent" | "terminal" | EpicArtifactKind,
): ReactElement {
  const Icon: LucideIcon = EPIC_NODE_ICONS[kind];
  return <Icon className={MENU_ICON_CLASS} aria-hidden />;
}
