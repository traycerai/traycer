import { createContext, useCallback, useContext, useRef } from "react";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { useEpicUpdateTitle } from "@/hooks/epic/use-epic-title-mutation";
import { useInlineRename } from "@/hooks/ui/use-inline-rename";
import type { HistoryActionScope } from "@/lib/history-composition/history-row-peer";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host";

interface HistoryTitleRenameRoute {
  readonly scope: HistoryActionScope;
  readonly resolveRequester: (
    scope: HistoryActionScope,
    item: HistoryItem,
  ) => HostRequester<HostRpcRegistry> | null;
}

export const HistoryTitleRenameContext =
  createContext<HistoryTitleRenameRoute | null>(null);

export function useHistoryTitleRename(item: HistoryItem, canEdit: boolean) {
  const route = useContext(HistoryTitleRenameContext);
  const draftScope = useRef<HistoryActionScope | null>(null);
  const { mutate: renameEpicTitle, isPending } = useEpicUpdateTitle();
  const commit = useCallback(
    (title: string) => {
      const scope = draftScope.current;
      draftScope.current = null;
      if (route === null || scope === null || item.taskType === "phase") return;
      // A draft can outlive cloud write permission. Local-home rows need no cloud capability.
      if (
        item.isLocalHome !== true &&
        !authorizesCloudCapability(useAuthStore.getState().status)
      ) {
        return;
      }
      const requester = route.resolveRequester(scope, item);
      if (requester === null) return;
      renameEpicTitle({
        requester,
        epicDelta: { id: item.epicId, title, updatedAt: Date.now() },
      });
    },
    [item, renameEpicTitle, route],
  );
  const { startEditing, ...rename } = useInlineRename({
    value: item.title,
    canEdit: canEdit && !isPending,
    onCommit: commit,
  });
  return {
    ...rename,
    isPending,
    startEditing: () => {
      draftScope.current = route?.scope ?? null;
      startEditing();
    },
  };
}
