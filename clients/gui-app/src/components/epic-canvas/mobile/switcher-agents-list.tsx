import { useMemo, useState } from "react";
import { SwitcherListHeader } from "@/components/epic-canvas/mobile/switcher-list-row";
import { SwitcherNewChatAction } from "@/components/epic-canvas/mobile/switcher-create-actions";
import { SwitcherAgentsViewMenu } from "@/components/epic-canvas/mobile/switcher-view-menu";
import { SwitcherSearchField } from "@/components/epic-canvas/mobile/switcher-search-field";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import {
  ChatTreeSurfaceContext,
  type ChatTreeSurface,
} from "@/components/epic-canvas/sidebar/chat-tree-surface";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { isEditableRole } from "@/lib/epic-permissions";
import { useEpicPermissionRole } from "@/lib/epic-selectors";

interface SwitcherListProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * What the surface tells the tree, through {@link ChatTreeSurface} rather than through a fork of it: - **The search query**, which is this sheet's state and not the panel store's.
 */
export function SwitcherAgentsList(props: SwitcherListProps) {
  const { epicId, tabId, onClose } = props;
  const coarsePointer = useCoarsePointer();
  const canMutate = isEditableRole(useEpicPermissionRole());
  const [searchQuery, setSearchQuery] = useState("");
  const surface = useMemo<ChatTreeSurface>(
    () => ({
      onRowActivated: onClose,
      revealRowControls: coarsePointer,
      searchQuery,
    }),
    [onClose, coarsePointer, searchQuery],
  );
  return (
    <ChatTreeSurfaceContext.Provider value={surface}>
      <div className="flex min-h-0 flex-1 flex-col pb-safe-bottom">
        {/* One header shape across both tabs: search, then create, then the
            view menu. */}
        <SwitcherListHeader
          search={
            <SwitcherSearchField
              value={searchQuery}
              onValueChange={setSearchQuery}
              placeholder="Search agents…"
              label="Search agents"
              clearLabel="Clear agent search"
              testIdPrefix="switcher-agents-search"
            />
          }
          action={
            canMutate ? (
              <SwitcherNewChatAction
                epicId={epicId}
                tabId={tabId}
                onClose={onClose}
              />
            ) : null
          }
          viewMenu={<SwitcherAgentsViewMenu epicId={epicId} />}
        />
        <ChatTreePanelBody epicId={epicId} tabId={tabId} />
      </div>
    </ChatTreeSurfaceContext.Provider>
  );
}
