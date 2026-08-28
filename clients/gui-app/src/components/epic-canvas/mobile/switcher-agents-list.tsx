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
 * Agents category: this sheet's own header over the DESKTOP sidebar's chat
 * tree.
 *
 * The list under the header used to be the switcher's own, and it surfaced
 * strictly less than the desktop row it stood in for: two menu entries against
 * desktop's five, no last-activity time, no shared-with-task marker, no
 * archived marking, a two-state icon against desktop's status ladder, and no
 * nesting. Matching a row property by property does not converge - each one
 * moves while the next drifts - so the tree component itself is mounted here.
 *
 * The HEADER stays this surface's, and deliberately. Desktop reaches search and
 * the view menu from its panel header, which `ChatTreePanelBody` does not
 * contain and a phone has no keyboard shortcut to substitute for; mounting the
 * body alone would leave both unreachable. So the sheet keeps the header it
 * already had and the tree supplies the rows.
 *
 * What the surface tells the tree, through {@link ChatTreeSurface} rather than
 * through a fork of it:
 *
 * - **The search query**, which is this sheet's state and not the panel store's.
 *   A sheet is dismissed the moment a row is tapped, so a persisted query would
 *   greet the next open with a narrowed list and no memory of why.
 * - **Closing.** A tap opens the row's preview tile exactly as on desktop - the
 *   tree still owns what opening means - and the sheet then closes, so the
 *   chosen tile becomes the full-screen mobile tile.
 * - **Row controls.** The "⋯" menu and archive shortcut reveal on hover. A
 *   coarse pointer has none, so they show outright; a fine pointer in a narrow
 *   window keeps the quieter behaviour.
 *
 * Everything else comes with the tree: nesting and its indent rails, the filter
 * and sort the view menu drives, the paired archive-hiding rule, the filtered
 * empty states, and a row menu carrying New child agent, Rename, Archive, Share
 * with task and Delete.
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
