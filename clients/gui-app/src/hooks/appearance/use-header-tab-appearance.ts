import { useMemo } from "react";
import { useLandingDraftAppearanceSource } from "./use-landing-draft-appearance";
import {
  useEpicAppearanceSource,
  useWorkspaceAppearance,
} from "./use-workspace-appearance";
import { resolvePrimaryPath } from "@/lib/worktree/resolve-primary-path";
import { sessionCreatedEpicHostId } from "@/lib/epics/session-created-epics";
import type {
  HeaderTab,
  HeaderTabRepositoryIdentity,
} from "@/stores/tabs/types";

function useHeaderTabAppearanceSource(tab: HeaderTab | null) {
  const draft = useLandingDraftAppearanceSource(
    tab?.kind === "draft" ? tab.id : null,
  );
  const epic = useEpicAppearanceSource({
    hostId:
      tab?.kind === "epic"
        ? (tab.hostId ?? sessionCreatedEpicHostId(tab.epicId))
        : null,
    epicId: tab?.kind === "epic" ? tab.epicId : "",
  });
  return tab?.kind === "draft"
    ? {
        hostId: draft.hostId,
        workspacePath: resolvePrimaryPath(draft.folders, draft.primaryPath),
      }
    : epic;
}

export function useHeaderTabAppearance(
  tab: HeaderTab | null,
): HeaderTab | null {
  const resolved = useWorkspaceAppearance(useHeaderTabAppearanceSource(tab));
  const color = resolved.appearance?.appearance?.color ?? null;
  const icon = resolved.appearance?.appearance?.icon ?? null;
  const accountId = resolved.scope?.accountId ?? null;
  const hostId = resolved.scope?.hostId ?? null;
  const canonicalSourceRoot = resolved.scope?.canonicalSourceRoot ?? null;
  const assetRefreshKey = resolved.assetRefreshKey;
  const iconRejected = resolved.appearance?.issues.includes("icon") ?? false;
  return useMemo(() => {
    if (tab === null || (tab.kind !== "draft" && tab.kind !== "epic")) {
      return tab;
    }
    if (color === null && icon === null) return tab;
    const repositoryIdentity: HeaderTabRepositoryIdentity = {
      color,
      icon,
      scope:
        accountId !== null && hostId !== null && canonicalSourceRoot !== null
          ? { accountId, hostId, canonicalSourceRoot }
          : null,
      assetRefreshKey,
      iconRejected,
    };
    return { ...tab, repositoryIdentity };
  }, [
    tab,
    color,
    icon,
    accountId,
    hostId,
    canonicalSourceRoot,
    assetRefreshKey,
    iconRejected,
  ]);
}
