import {
  Files,
  FolderTree,
  GitBranch,
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
  /**
   * Whether this panel's header row can be traded for a search input while
   * searching (see `panel-header-search-store`). Panels that opt out never
   * render the portal target, so their header is always the standard row.
   */
  readonly supportsHeaderSearch: boolean;
}

export const LEFT_PANEL_DEFINITIONS: ReadonlyArray<LeftPanelMetadataDefinition> =
  [
    {
      id: "chats",
      title: "Chats",
      icon: MessagesSquare,
      isVisible: () => true,
      supportsHeaderSearch: false,
    },
    {
      id: "terminals",
      title: "Terminals",
      icon: Terminal,
      isVisible: () => true,
      supportsHeaderSearch: false,
    },
    {
      id: "artifacts",
      title: "Artifacts",
      icon: Files,
      isVisible: () => true,
      supportsHeaderSearch: true,
    },
    {
      id: "git-diff",
      title: "Git Diff",
      icon: GitBranch,
      isVisible: () => true,
      supportsHeaderSearch: false,
    },
    {
      id: "file-tree",
      title: "File Tree",
      icon: FolderTree,
      isVisible: () => true,
      supportsHeaderSearch: false,
    },
    {
      id: "sharing",
      title: "Sharing",
      icon: UserPlus,
      isVisible: () => true,
      supportsHeaderSearch: false,
    },
    {
      id: "comments",
      title: "Comments",
      icon: MessageSquareText,
      isVisible: (context) =>
        context.commentsPanelRevealed && context.hasActiveCommentableArtifact,
      supportsHeaderSearch: false,
    },
  ];
