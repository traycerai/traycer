import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

/**
 * A watching surface's host travels with a jump into Settings.
 *
 * Without this, scoping Usage (or the resource monitor) to host B and pressing
 * a Settings CTA opens controls for whatever host Settings last showed — the
 * action was invoked FROM B's numbers, so changes made next would target the
 * wrong machine.
 *
 * The DISPLAYED host, pinned or followed. An earlier version transferred only
 * an explicit pin, reasoning that `null` means both surfaces agree on "follow"
 * — but Settings can hold a stale explicit pin of its own, and its panels
 * resolve through Settings' scope, so the followed case landed on the wrong
 * machine all the same.
 *
 * Shared by every read-only host surface with a Settings CTA, rather than
 * copied per popover: two implementations of one rule is how one of them
 * silently stops matching the other.
 */
export function carryViewedHostIntoSettingsScope(
  displayedHostId: string | null,
): void {
  if (displayedHostId === null) return;
  useSettingsHostScopeStore.getState().setScopedHostId(displayedHostId);
}
