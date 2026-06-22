import { useEffect, useRef, type RefObject } from "react";
import { useRouterState } from "@tanstack/react-router";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import { epicRoleToast } from "@/lib/toast/channels";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import { readActiveEpicIdFromPath } from "@/lib/routes";

interface EpicConnectionToastsProps {
  readonly epicId: string;
}

/**
 * Surfaces per-tab role-change toasts. Connection state is represented by the
 * status pill, so transient Tiptap disconnect/reconnect cycles stay quiet.
 */
export function EpicConnectionToasts(props: EpicConnectionToastsProps) {
  const { epicId } = props;
  const role = useEpicPermissionRole();
  const isActiveTab = useRouterState({
    select: (state) =>
      readActiveEpicIdFromPath(state.location.pathname) === epicId,
  });

  useRoleChangeToasts(role, isActiveTab, epicId);

  return null;
}

/**
 * Surfaces role upgrade/downgrade toasts on live permission transitions.
 * The *first* role the tab ever sees is the initial snapshot - we skip
 * it so opening a tab as viewer does not fire a "you can no longer edit"
 * toast. Only transitions that happen after the tab has a real role are
 * considered a live change. `permissionRole === null` (full revoke) is
 * handled upstream by the access-lost banner and is not re-toasted here.
 */
function useRoleChangeToasts(
  role: PermissionRole | null,
  isActiveTab: boolean,
  epicId: string,
): void {
  const previous = useRef<PermissionRole | null | "uninit">("uninit");
  useEffect(() => {
    syncRoleChangeToasts({ role, isActiveTab, epicId, previous });
  }, [role, isActiveTab, epicId]);
}

interface RoleChangeToastsInput {
  readonly role: PermissionRole | null;
  readonly isActiveTab: boolean;
  readonly epicId: string;
  readonly previous: RefObject<PermissionRole | null | "uninit">;
}

function syncRoleChangeToasts(input: RoleChangeToastsInput): void {
  const { role, isActiveTab, epicId, previous } = input;
  const prior = previous.current;
  previous.current = role;
  if (prior === "uninit") return;
  if (!isActiveTab) return;
  if (role === null) return;
  if (prior === null) return;
  if (prior === role) return;
  const gainedWrite =
    (prior === "viewer" && role !== "viewer") ||
    (prior === "editor" && role === "owner");
  const lostWrite = prior !== "viewer" && role === "viewer";
  // Upgrade and downgrade share one channel id per epic: a rapid up-then-down
  // (or repeated change) collapses to the latest role instead of stacking.
  const channel = epicRoleToast(epicId);
  if (gainedWrite) {
    channel.success(roleUpgradeMessage(role));
    return;
  }
  if (prior === "owner" && role === "editor") {
    channel.info("Your role on this Epic is now Editor.");
    return;
  }
  if (lostWrite) {
    channel.warning(
      "Your role on this Epic is now Viewer. Pending edits were discarded.",
    );
  }
}

function roleUpgradeMessage(role: PermissionRole): string {
  if (role === "owner") return "Your role on this Epic is now Owner.";
  return "Your role on this Epic is now Editor.";
}
