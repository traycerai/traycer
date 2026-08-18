import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  filterHeaderStripItemIdsForProject,
  headerTabProjectBadge,
  headerTabRecordMatchesProject,
  resolveEpicWorkspaceHint,
  resolveOwningProjectProfile,
  stampedWorkspaceHintForEpic,
  workspaceHintFromSnapshotFolders,
  type EpicWorkspaceHint,
} from "@/lib/workspace/header-tab-matches-project";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { selectHeaderStripItemIds } from "@/stores/tabs/selectors";
import { useTabsStore } from "@/stores/tabs/store";
import { activeHostIdOrNull } from "@/lib/host/runtime";
import type { HeaderTab } from "@/stores/tabs/types";
import {
  selectActiveProjectProfile,
  selectProjectProfilesBucket,
  useProjectProfilesStore,
  type ProjectProfile,
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
        workspaceHintForEpic: (epicId) =>
          workspaceHintForEpic(epicId, epicTabsById),
      }),
    [epicTabsById, itemIds, items, profile],
  );
}

export function usePersistOpenEpicWorkspaceStamps(): void {
  const stampEpicWorkspaceHint = useEpicCanvasStore(
    (state) => state.stampEpicWorkspaceHint,
  );
  const openTabs = useEpicCanvasStore(
    useShallow((state) =>
      state.openTabOrder.flatMap((tabId) => {
        const tab = state.tabsById[tabId];
        return tab === undefined ? [] : [tab];
      }),
    ),
  );
  useEffect(() => {
    for (const tab of openTabs) {
      const live = liveWorkspaceHintForEpic(tab.epicId);
      if (live === null) continue;
      if (
        (tab.projectWorkspace?.primaryPath ?? null) ===
        (live.primaryPath ?? null)
      ) {
        continue;
      }
      stampEpicWorkspaceHint(tab.epicId, {
        primaryPath: live.primaryPath ?? null,
        linkedWorkspaces: live.linkedWorkspaces,
        worktreePaths: live.worktreePaths,
      });
    }
  }, [openTabs, stampEpicWorkspaceHint]);
}

export function workspaceHintForOpenEpic(
  epicId: string,
): EpicWorkspaceHint | null {
  return workspaceHintForEpic(
    epicId,
    useEpicCanvasStore.getState().tabsById,
  );
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
  const tabsById = useEpicCanvasStore.getState().tabsById;
  return tabs.filter((tab) =>
    headerTabRecordMatchesProject(
      tab,
      profile,
      tab.kind === "epic" ? workspaceHintForEpic(tab.epicId, tabsById) : null,
    ),
  );
}

export function readActiveHostIdForProjectScope(): string | null {
  return activeHostIdOrNull();
}

export function useHeaderTabProjectBadge(
  tab: HeaderTab,
): { readonly color: ProjectProfile["color"]; readonly name: string } | null {
  const hostId = useAddressableHostId();
  const tabsById = useEpicCanvasStore(useShallow((state) => state.tabsById));
  const hint =
    tab.kind === "epic" ? workspaceHintForEpic(tab.epicId, tabsById) : null;
  return useProjectProfilesStore(
    useShallow((state) => {
      if (tab.kind !== "epic") return null;
      const bucket = selectProjectProfilesBucket(state, hostId);
      const active = selectActiveProjectProfile(state, hostId);
      const owner = resolveOwningProjectProfile(
        bucket.profiles,
        tab.epicId,
        hint,
      );
      return headerTabProjectBadge(active, owner);
    }),
  );
}

function workspaceHintForEpic(
  epicId: string,
  tabsById: Parameters<typeof stampedWorkspaceHintForEpic>[0],
): EpicWorkspaceHint | null {
  return resolveEpicWorkspaceHint({
    live: liveWorkspaceHintForEpic(epicId),
    stamped: stampedWorkspaceHintForEpic(tabsById, epicId),
  });
}

function liveWorkspaceHintForEpic(epicId: string): EpicWorkspaceHint | null {
  const handle = getOpenEpicRegistry().peek(epicId);
  if (handle === null) return null;
  const folders = handle.store.getState().snapshotMeta?.workspaceFolders;
  if (folders === undefined) return null;
  return workspaceHintFromSnapshotFolders(folders);
}
