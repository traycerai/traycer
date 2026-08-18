import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  filterHeaderStripItemIdsForProject,
  type EpicWorkspaceHint,
} from "@/lib/workspace/header-tab-matches-project";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { selectHeaderStripItemIds } from "@/stores/tabs/selectors";
import { useTabsStore } from "@/stores/tabs/store";
import { activeHostIdOrNull } from "@/lib/host/runtime";
import { headerTabRecordMatchesProject } from "@/lib/workspace/header-tab-matches-project";
import type { HeaderTab } from "@/stores/tabs/types";
import {
  selectActiveProjectProfile,
  useProjectProfilesStore,
} from "@/stores/workspace/project-profiles-store";

export function useProjectScopedHeaderStripItemIds(): ReadonlyArray<string> {
  const hostId = useAddressableHostId();
  const profile = useProjectProfilesStore((state) =>
    selectActiveProjectProfile(state, hostId),
  );
  const itemIds = useTabsStore(useShallow(selectHeaderStripItemIds));
  const items = useTabsStore(useShallow((state) => state.items));
  const epicTabsById = useEpicCanvasStore(
    useShallow((state) => state.tabsById),
  );
  return useMemo(
    () =>
      filterHeaderStripItemIdsForProject({
        itemIds,
        items,
        profile,
        epicIdForTabId: (tabId) => epicTabsById[tabId]?.epicId ?? null,
        workspaceHintForEpic,
      }),
    [epicTabsById, itemIds, items, profile],
  );
}

export function workspaceHintForOpenEpic(
  epicId: string,
): EpicWorkspaceHint | null {
  return workspaceHintForEpic(epicId);
}

export function scopeHeaderTabsToActiveProject(
  tabs: ReadonlyArray<HeaderTab>,
  hostId: string | null,
): ReadonlyArray<HeaderTab> {
  const profile = selectActiveProjectProfile(
    useProjectProfilesStore.getState(),
    hostId,
  );
  if (profile === null) return tabs;
  return tabs.filter((tab) =>
    headerTabRecordMatchesProject(
      tab,
      profile,
      tab.kind === "epic" ? workspaceHintForEpic(tab.epicId) : null,
    ),
  );
}

export function readActiveHostIdForProjectScope(): string | null {
  return activeHostIdOrNull();
}

function workspaceHintForEpic(epicId: string): EpicWorkspaceHint | null {
  const handle = getOpenEpicRegistry().peek(epicId);
  if (handle === null) return null;
  const folders = handle.store.getState().snapshotMeta?.workspaceFolders;
  if (folders === undefined || folders.length === 0) return null;
  return {
    worktreePaths: [],
    linkedWorkspaces: folders.map((folder) => ({
      hostId: folder.hostId,
      workspacePath: folder.workspacePath,
    })),
  };
}
