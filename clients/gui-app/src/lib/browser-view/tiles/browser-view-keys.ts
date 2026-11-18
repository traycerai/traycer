import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";

/**
 * Unit separator: no id in this feature may contain it, so a composite key
 * can never be forged by a value that happens to embed the separator.
 */
const KEY_SEPARATOR = "\u001f";

export function compositeKey(...parts: readonly string[]): string {
  return parts.join(KEY_SEPARATOR);
}

export function browserViewTileKeyId(key: BrowserViewTileKey): string {
  return compositeKey(
    key.viewTabId,
    key.paneId,
    key.tileInstanceId,
    key.pageSessionId,
  );
}

/**
 * Whether two tile keys name the same mounted surface. The one comparator, so
 * a field added to `BrowserViewTileKey` cannot be forgotten by a subscriber
 * that hand-rolled its own field-by-field equality.
 */
export function isSameBrowserViewTile(
  a: BrowserViewTileKey,
  b: BrowserViewTileKey,
): boolean {
  return browserViewTileKeyId(a) === browserViewTileKeyId(b);
}
