import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Whether a permission role may mutate the epic (create / edit / delete).
 * Single source of truth shared by every surface that gates on edit rights;
 * pairs with `useEpicPermissionRole` (epic-selectors).
 *
 * Kept in its own module - not in `epic-selectors` - because `epic-selectors`
 * is heavily `vi.mock`ed in component tests; a pure predicate living here stays
 * real across those mocks instead of needing to be re-listed in each factory.
 */
export function isEditableRole(role: PermissionRole | null): boolean {
  return role === "owner" || role === "editor";
}

/**
 * Tooltip copy for a mutation control that is disabled but still visible
 * ("locked, not hidden" - see the sidebar create actions and the New
 * Conversation modal). Disconnect takes precedence over an unresolved role: it
 * is the more actionable condition (reconnecting fixes it).
 *
 * It no longer names the action. A role that may open the task may change it,
 * so the only two reasons left are about the connection and about not knowing
 * the role yet - neither of which varies by what the control does.
 */
export function mutationDisabledHint(
  role: PermissionRole | null,
  isDisconnected: boolean,
): string | null {
  if (isDisconnected) return "Reconnect to make changes.";
  if (role === null) return "Task permissions are not available yet.";
  return null;
}
