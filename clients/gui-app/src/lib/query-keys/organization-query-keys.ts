import { hostQueryKeys } from "./host-query-keys";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
export const organizationKeys = {
  view: (hostId: string | null, userId: string | null) =>
    [
      ...hostQueryKeys.method<HostRpcRegistry, "organization.read">(
        hostId,
        "organization.read",
        { taskIds: [] },
      ),
      userId,
    ] as const,
  command: () => ["organization", "command"] as const,
  workflow: (
    control:
      | "create-group"
      | "save-label"
      | "toggle-label"
      | "delete-label"
      | "save-icon",
  ) => ["organization", "workflow", control] as const,
};
