import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

export function isWorktreeRebindBlocked(error: unknown): boolean {
  return (
    error instanceof HostRpcError && error.code === "WORKTREE_REBIND_BLOCKED"
  );
}
