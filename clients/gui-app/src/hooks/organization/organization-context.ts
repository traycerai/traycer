import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { createContext, use, useEffect, useId } from "react";
import type {
  OrganizationAction,
  OrganizationView,
} from "@traycer/protocol/host/organization/contracts";
import type { TaskOrganization } from "@traycer/protocol/host/organization/schemas";
import type { OrganizationDialog } from "@/components/organization/organization-dialogs";
export interface OrganizationContextValue {
  readonly client: HostClient<HostRpcRegistry>;
  readonly supported: boolean;
  readonly userId: string | null;
  readonly view: OrganizationView | undefined;
  readonly register: (key: string, taskIds: readonly string[]) => () => void;
  readonly openDialog: (dialog: OrganizationDialog) => void;
  readonly command: (action: OrganizationAction) => Promise<void>;
  readonly refresh: () => Promise<void>;
}
export const OrganizationContext =
  createContext<OrganizationContextValue | null>(null);
const EMPTY_IDS: readonly string[] = [];

export function useOrganization() {
  return use(OrganizationContext);
}
export function useOrganizationTasks(taskIds: readonly string[]) {
  const organization = useOrganization();
  const register = organization?.register;
  const id = useId();
  const identity = [...new Set(taskIds)].sort().join(",");
  useEffect(
    () => register?.(id, identity ? identity.split(",") : EMPTY_IDS),
    [register, id, identity],
  );
  return organization;
}
export function taskOrganization(
  view: OrganizationView | undefined,
  taskId: string,
  fallback: TaskOrganization | undefined,
): TaskOrganization | undefined {
  if (view === undefined) return fallback;
  const groupId = view.groups.memberships.find(
    (m) => m.taskId === taskId,
  )?.groupId;
  const group = view.groups.groups.find((g) => g.groupId === groupId) ?? null;
  const appearance =
    view.appearances.find((a) => a.taskId === taskId) ?? fallback?.appearance;
  const labels =
    Object.entries(view.taskLabels).find(([id]) => id === taskId)?.[1].labels ??
    fallback?.labels;
  if (appearance === undefined && labels === undefined && group === null)
    return fallback;
  return {
    group,
    appearance: appearance ?? { taskId, version: "0", color: null, icon: null },
    labels: labels ?? [],
  };
}

export function organizationPreflight(
  client: HostClient<HostRpcRegistry> | null,
  userId: string | null,
  method:
    | "organization.command"
    | "organization.refresh"
    | "organization.history",
): () => void {
  return () => {
    cloudVerdictPreflight(method)();
    if (
      userId === null ||
      client?.getRequestContextUserId() !== userId ||
      useAuthStore.getState().contextMetadata?.userId !== userId
    )
      throw new Error(
        "Organization account changed. Reopen this control to try again.",
      );
  };
}
