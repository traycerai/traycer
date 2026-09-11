/**
 * Which tiles on this canvas somebody ASKED for in this session, as opposed to
 * the ones the persisted layout put back.
 *
 * ## Why a tile needs to know
 *
 * Opening a terminal-agent tile starts its agent: the bootstrap sees no live
 * session and creates one, resuming the conversation. That is right for a
 * click - "opening it resumes the same session" is the promise the sleeping
 * agent's own copy makes - and wrong for a restore, where an epic whose canvas
 * holds ten sleeping agents would spawn ten provider CLIs the moment the tab
 * is shown, which is precisely the cost the host's idle reap freed.
 *
 * The two are indistinguishable from inside a tile: a restored tile and a
 * clicked one mount identically, with the same ref and the same props. What
 * separates them is whether anything CALLED the open seam for that tile in
 * this session, and that is what this records.
 *
 * ## Why it is a session set and not a field on the tile
 *
 * The tile refs are persisted (`partialize` in the canvas store), so a flag
 * written onto one would be restored with it and every tile would read as
 * explicitly opened on the second run. The distinction is about THIS session
 * by construction, so it lives in memory that dies with the page.
 *
 * ## What counts
 *
 * Every open goes through `openTileWithNavigation` - the seam
 * `traycer-tile-open-boundary-rules` exists to make the only one - so marking
 * there covers the click, the palette, a drag-and-drop commit, tab activation
 * and a host push alike. A host push is deliberately included: an agent asking
 * for a tile is still something asking, and the tile it asks for is one
 * somebody is about to look at.
 *
 * A tile opened in this session, closed with its epic tab and restored later
 * keeps its instance id and therefore still reads as requested. That is a
 * single stale entry, and it errs toward today's behaviour (start the agent)
 * rather than toward a tile that silently refuses to.
 */
const requestedInstanceIds = new Set<string>();

/**
 * Record that this tile instance was opened by a request rather than restored.
 * Called by the open seam; nothing else should.
 */
export function markTileOpenRequested(instanceId: string): void {
  requestedInstanceIds.add(instanceId);
}

/**
 * Whether this tile instance was opened by a request in this session. `false`
 * for a tile the persisted layout restored - including on the very first
 * render, which is what a mount-time decision needs.
 */
export function wasTileOpenRequested(instanceId: string): boolean {
  return requestedInstanceIds.has(instanceId);
}
