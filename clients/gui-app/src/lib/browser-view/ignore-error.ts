/**
 * Terminal `.catch` for a browser-view host call whose failure the caller has
 * nothing to do about - the view is gone, the tile is unmounting, or the
 * bridge is down. Named so a swallowed rejection reads as deliberate.
 */
export function ignoreError(_error: unknown): void {}
