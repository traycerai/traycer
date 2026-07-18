import {
  Files,
  FolderTree,
  GitBranch,
  GitPullRequest,
  MessageSquareText,
  MessagesSquare,
  Terminal,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import type { LeftPanelId } from "@/stores/epics/left-panel-store";

export interface LeftPanelAvailabilityContext {
  readonly commentsPanelRevealed: boolean;
  readonly hasActiveCommentableArtifact: boolean;
}

/** Props for the panel `Body` and `Actions` slots in the registry. */
export interface LeftPanelSlotProps {
  readonly epicId: string;
  readonly tabId: string;
}

export interface LeftPanelMetadataDefinition {
  readonly id: LeftPanelId;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly isVisible: (context: LeftPanelAvailabilityContext) => boolean;
}

export const LEFT_PANEL_DEFINITIONS: ReadonlyArray<LeftPanelMetadataDefinition> =
  [
    {
      id: "chats",
      title: "Chats",
      icon: MessagesSquare,
      isVisible: () => true,
    },
    {
      id: "terminals",
      title: "Terminals",
      icon: Terminal,
      isVisible: () => true,
    },
    {
      id: "artifacts",
      title: "Artifacts",
      icon: Files,
      isVisible: () => true,
    },
    {
      id: "git-diff",
      title: "Git Diff",
      icon: GitBranch,
      isVisible: () => true,
    },
    {
      id: "pull-requests",
      title: "Pull Requests",
      icon: GitPullRequest,
      isVisible: () => true,
    },
    {
      id: "file-tree",
      title: "File Tree",
      icon: FolderTree,
      isVisible: () => true,
    },
    {
      id: "sharing",
      title: "Sharing",
      icon: UserPlus,
      isVisible: () => true,
    },
    {
      id: "comments",
      title: "Comments",
      icon: MessageSquareText,
      isVisible: (context) =>
        context.commentsPanelRevealed && context.hasActiveCommentableArtifact,
    },
  ];
