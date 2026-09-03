import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import type {
  BrowserViewTileKey,
  BrowserViewViewportPresetId,
} from "@traycer-clients/shared/platform/browser-view";

/**
 * Where a shared browser tab tile is mounted. The tile body and its two
 * surfaces read placement instead of canvas context, which is what lets one
 * component serve both the task canvas and the Start Page panel.
 *
 * The canvas arm's `viewTabId`/`paneId` are the canvas coordinates the tile
 * key and the surface binding id are built from. The landing arm names the
 * panel's page instead; only the canvas arm has a caller today (the Start Page
 * adapter arrives with its own ticket), but both derivations below are written
 * now so that adapter has nothing left to invent.
 */
export type BrowserTilePlacement =
  | {
      readonly kind: "canvas";
      readonly epicId: string;
      readonly viewTabId: string;
      readonly paneId: string;
    }
  | { readonly kind: "landing"; readonly landingPageId: string };

/**
 * One host-owned browser tab, addressed the way the tile needs it and with no
 * scope of its own - the placement carries that.
 *
 * Deliberately NOT carrying a `url`: the address the tile renders is the LIVE
 * `tab.url` from the sessions inventory, which the body resolves after it has
 * found the session and tab. A url here would be a second, staler answer to a
 * question the body already asks. There is likewise no node `id`: the canvas
 * ref's id exists to key a canvas node, and every consumer that used to read
 * it takes `pageSessionId` instead.
 */
export interface BrowserTileNode {
  readonly instanceId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly viewportPreset: BrowserViewViewportPresetId;
}

/** The canvas coordinates a placement names, whatever it calls them. */
function browserTileCoordinates(placement: BrowserTilePlacement): {
  readonly viewTabId: string;
  readonly paneId: string;
} {
  if (placement.kind === "canvas") {
    return { viewTabId: placement.viewTabId, paneId: placement.paneId };
  }
  return { viewTabId: placement.landingPageId, paneId: "landing-panel" };
}

/**
 * The scope every host-owned browser resource under this tile is addressed
 * under. A canvas tile belongs to its epic; a Start Page tile belongs to no
 * epic at all, which the wire spells `independent` rather than with an empty
 * or sentinel epic id.
 */
export function browserTileScope(
  placement: BrowserTilePlacement,
): HostResourceScope {
  if (placement.kind === "canvas") {
    return { kind: "epic", epicId: placement.epicId };
  }
  return { kind: "independent" };
}

/**
 * The epic a placement names, or `null` where there is none.
 *
 * This is NOT the scope, and it is not a shortcut around it: the one consumer
 * is the annotation session, which routes a captured annotation into a chat in
 * a specific epic and therefore genuinely wants an epic id. A tile with no epic
 * has no annotation target, and the surface keeps the session inert there by
 * handing it a null browser view - the same way it already does on the start
 * page.
 */
export function browserTileEpicId(
  placement: BrowserTilePlacement,
): string | null {
  return placement.kind === "canvas" ? placement.epicId : null;
}

/**
 * The key naming this tile's native surface to the desktop. Opaque to main,
 * which never interprets it - it only has to be stable for one mounted tile
 * and distinct between tiles.
 */
export function browserTileKey(
  placement: BrowserTilePlacement,
  tileInstanceId: string,
  pageSessionId: string,
): BrowserViewTileKey {
  const { viewTabId, paneId } = browserTileCoordinates(placement);
  return { viewTabId, paneId, tileInstanceId, pageSessionId };
}

/**
 * The surface binding id, likewise opaque to the desktop. Placement-prefixed so
 * a canvas tile and a Start Page tile can never collide on one, and unchanged
 * for the canvas arm, where it stays `canvas<US>viewTab<US>pane<US>instance`.
 */
export function browserTileBindingId(
  placement: BrowserTilePlacement,
  tileInstanceId: string,
): string {
  const { viewTabId, paneId } = browserTileCoordinates(placement);
  return [placement.kind, viewTabId, paneId, tileInstanceId].join("\u001f");
}
