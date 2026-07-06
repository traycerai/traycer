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
 * Conversation modal). Disconnect takes precedence over role: it is the more
 * actionable condition (reconnecting fixes it; waiting for a role change does
 * not).
 */
export function mutationDisabledHint(
  role: PermissionRole | null,
  isDisconnected: boolean,
  action: string,
): string | null {
  if (isDisconnected) return "Reconnect to make changes.";
  if (!isEditableRole(role)) return `Viewers cannot ${action}.`;
  return null;
}
