import type { SurfaceGroupId } from "@/components/layout-editor/regions/region-grammar";
import type { RegionId } from "@/lib/layout/region-id";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { settingsSectionPath } from "@/stores/tabs/kinds/settings";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * Move the Settings surface to `sectionId`, whichever surface it is.
 *
 * Settings renders in two places — a modal overlay and a system tab — and a
 * panel has no way to tell which one is hosting it. The modal bridge does:
 * with the overlay up it swaps the section in place, and otherwise
 * `openSettings` focuses an existing settings TAB at that section (or opens
 * the modal if there is none). Callers therefore get correct behaviour in both
 * modes without reaching for router hooks, which the modal — or a unit test —
 * may not have.
 *
 * Three callers now: the keybinding router adapter, and the two halves of the
 * Providers <-> Fallback cross-link - the Fallback panel's profile-step hint
 * pointing at Providers, and Providers ▸ Profiles & Limits pointing back. The
 * panel pair is why the indirection exists: a router `Link` is wrong in a
 * panel, because under the modal overlay it navigates the router BEHIND the
 * overlay rather than moving the section the user is looking at.
 *
 * Returns whether a Settings surface was actually reached. It is `false` only
 * when the bridge has not published an API yet - a cold launch behind
 * `HostReadyGate` - and a caller whose whole gesture is this navigation (the
 * layout editor's width-gate redirect) has to say something rather than look
 * like a dead press. Every caller that navigates AS PART of something else
 * ignores it, which is why this is a return value and not a throw.
 */
export function navigateToSettingsSection(
  sectionId: SettingsSectionId,
): boolean {
  const api = getSystemTabModalApi();
  if (api === null) return false;
  if (api.isOverlayActive("settings")) {
    api.setSection(sectionId);
    return true;
  }
  api.openSettings({
    section: sectionId,
    resetToGeneral: false,
    tab: null,
    draft: null,
    hostId: null,
  });
  return true;
}

/**
 * Dismiss whichever system overlay is up, if any. No-op when none is.
 *
 * The Settings and History modals are portalled dialogs over the whole app, so
 * a surface that takes the app over - the layout editor - has to put them away
 * rather than open behind them (L-91).
 *
 * The `active` guard is the load-bearing half: `close()` walks the router's
 * history back when the entry it would pop is an overlay entry, and with no
 * overlay open that test can still pass, which would turn "customize this
 * layout" into "go back".
 */
export function closeSystemOverlay(): void {
  const api = getSystemTabModalApi();
  if (api === null || api.active === null) return;
  api.close();
}

/**
 * Move the Settings surface to `Layout` AND say where on it to land: a region's
 * row, or an area.
 *
 * The companion to {@link navigateToSettingsSection} rather than a second
 * argument on it, because the target is not a section: it is a place inside
 * one, and only one page has any. Two callers: the editor's width-gate
 * redirect, which below 1100px sends the user to the region they asked for
 * instead of opening a canvas (A.5), and the editor's exit, which returns a
 * session opened from this page to the area it was opened from.
 *
 * The request OUTLIVES the call, like the settings-search reveal it sits
 * beside: the panel mounts after the navigation commits, so it is published
 * here and taken by whichever Layout page renders next.
 */
export function navigateToLayoutRegion(regionId: RegionId): boolean {
  return navigateToLayoutLanding({ kind: "region", regionId });
}

/**
 * One list row inside a region's own section, by its `data-sortable-id`: the
 * controller a reason names when that is not the region itself (a provider
 * in Usage limits' Profiles list, U5).
 */
export function navigateToLayoutRegionRow(
  regionId: RegionId,
  row: string,
): boolean {
  return navigateToLayoutLanding({ kind: "region-row", regionId, row });
}

/** `null` is the Presets area. */
export function navigateToLayoutArea(area: SurfaceGroupId | null): boolean {
  return navigateToLayoutLanding({ kind: "area", area });
}

function navigateToLayoutLanding(target: LayoutLandingTarget): boolean {
  if (!navigateToSettingsSection("layout")) return false;
  pendingLayoutLanding = { target, requestedAt: Date.now() };
  for (const listener of pendingLayoutLandingListeners) listener();
  return true;
}

export type LayoutLandingTarget =
  | { readonly kind: "region"; readonly regionId: RegionId }
  | {
      readonly kind: "region-row";
      readonly regionId: RegionId;
      readonly row: string;
    }
  | { readonly kind: "area"; readonly area: SurfaceGroupId | null };

export interface PendingLayoutLanding {
  readonly target: LayoutLandingTarget;
  /**
   * Tells two consecutive requests for the SAME place apart, which is what
   * asking twice produces - without it the second is a no-op and the user, who
   * asked precisely because they wanted to be shown again, sees nothing.
   */
  readonly requestedAt: number;
}

/**
 * Held as one stable object, replaced only on a write, so a `useSyncExternal
 * Store` read of it is referentially stable between requests.
 */
let pendingLayoutLanding: PendingLayoutLanding | null = null;
const pendingLayoutLandingListeners = new Set<() => void>();

export function readPendingLayoutLanding(): PendingLayoutLanding | null {
  return pendingLayoutLanding;
}

/**
 * The request is spent: one landing per request, however many pages mount.
 *
 * It notifies, like the write does. A reader that took the request while its
 * subscribers still believed it was there would keep re-rendering against a
 * value the store no longer holds.
 */
export function takePendingLayoutLanding(): PendingLayoutLanding | null {
  const pending = pendingLayoutLanding;
  if (pending === null) return null;
  pendingLayoutLanding = null;
  for (const listener of pendingLayoutLandingListeners) listener();
  return pending;
}

export function subscribePendingLayoutLanding(
  listener: () => void,
): () => void {
  pendingLayoutLandingListeners.add(listener);
  return () => {
    pendingLayoutLandingListeners.delete(listener);
  };
}

/**
 * Move the Settings TAB's own section without activating anything.
 *
 * `navigateToSettingsSection` is a command: it focuses the Settings tab, which
 * in a split takes the partner's focus and route. This is for the caller that
 * has to change what Settings shows while Settings is not the focused surface -
 * Settings is only remembering where it is, and the section it draws follows
 * that remembered path whenever a split partner owns the route.
 */
export function rememberSettingsTabSection(sectionId: SettingsSectionId): void {
  useTabsStore
    .getState()
    .rememberSystemTabPath("settings", settingsSectionPath(sectionId));
}
