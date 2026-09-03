import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import type {
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayOcclusionResult,
  BrowserViewOverlayRelease,
  BrowserViewOverlayReleaseResult,
  BrowserViewOverlaySnapshot,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import { describeLogError, log } from "../../app/logger";
import {
  requireSurface,
  toTileKey,
  type BrowserViewEntry,
  type BrowserViewSend,
} from "./browser-view-entry";
import {
  browserViewSurfaceKey as entryKeyId,
  type BrowserViewEntryRegistry,
} from "./browser-view-entry-registry";
import type { BrowserViewGeometry } from "./browser-view-geometry";

interface BrowserViewOverlayOptions {
  readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  readonly geometry: BrowserViewGeometry;
  readonly send: BrowserViewSend;
}

/** What one tile's occlusion actually did: see `occludeEntry`. */
interface OccludeEntryResult {
  readonly occluded: boolean;
  readonly snapshot: BrowserViewOverlaySnapshot | null;
}

const MISSED: OccludeEntryResult = { occluded: false, snapshot: null };
const ALREADY_OCCLUDED: OccludeEntryResult = { occluded: true, snapshot: null };

/**
 * Invariant 6: the stand-in is a frozen, pixel-perfect frame, sourced from a
 * native-resolution `capturePage()` at swap time. The rolling warm cache is
 * only the deadline fallback, so `capturePage` is raced against roughly two
 * frames' worth of time.
 *
 * ponytail: two frames is a guess, not a measurement - ticket 09's live CDP
 * probe measures real capture latency and settles this value.
 */
const CAPTURE_STANDIN_DEADLINE_FRAMES = 2;
const ASSUMED_FRAME_MS = 1000 / 60;
export const CAPTURE_STANDIN_DEADLINE_MS =
  CAPTURE_STANDIN_DEADLINE_FRAMES * ASSUMED_FRAME_MS;
// PNG's synchronous multi-MB encode (`toDataURL()`) at native resolution was
// itself eating into the ~2-frame capture deadline above; JPEG at this
// quality keeps native RESOLUTION (the fidelity that matters for a
// pixel-perfect stand-in) while encoding far faster and smaller.
// ponytail: 92 is a guess, not a measurement - ticket 09's live CDP probe
// measures real encode-ms/bytes and may revisit this value.
const CAPTURE_STANDIN_JPEG_QUALITY = 92;

/** Sentinel returned when the deadline elapses before `capturePage` settles. */
const CAPTURE_DEADLINE_ELAPSED = Symbol("capture-standin-deadline");

/**
 * Invariant 4 exit-edge handshake: liveness escape only, not a race patch -
 * the race itself is decided by `awaitNextFrame`'s frame signal. Bounds how
 * long a release waits for the un-parked view's first composited frame
 * before telling the renderer to drop the stand-in anyway, so a compositor
 * that never delivers (a view that produced no frame) cannot strand it
 * forever.
 *
 * ponytail: a guess, like the capture deadline above - ticket 09's live CDP
 * probe measures real restore-to-first-frame latency and may revisit this.
 */
const RESTORE_FRAME_BUDGET_FRAMES = 4;
export const RESTORE_FRAME_BUDGET_MS =
  RESTORE_FRAME_BUDGET_FRAMES * ASSUMED_FRAME_MS;

type RestorePath = "frame" | "no-subscription" | "budget-elapsed";

async function raceRestoreFrameAgainstBudget(
  frame: Promise<void>,
): Promise<RestorePath> {
  let deadlineTimer: NodeJS.Timeout | undefined;
  const budget = new Promise<RestorePath>((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve("budget-elapsed"),
      RESTORE_FRAME_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([frame.then((): RestorePath => "frame"), budget]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function raceCaptureAgainstDeadline(
  entry: BrowserViewEntry,
): Promise<string | typeof CAPTURE_DEADLINE_ELAPSED | null> {
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof CAPTURE_DEADLINE_ELAPSED>((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve(CAPTURE_DEADLINE_ELAPSED),
      CAPTURE_STANDIN_DEADLINE_MS,
    );
  });
  const capture = entry.view.webContents
    .capturePage()
    .then(
      (image) =>
        `data:image/jpeg;base64,${Buffer.from(
          image.toJPEG(CAPTURE_STANDIN_JPEG_QUALITY),
        ).toString("base64")}`,
    )
    .catch((err: unknown) => {
      log.warn("[browser-view] overlay snapshot capture failed", {
        error: describeLogError(err),
        webContentsId: entry.view.webContents.id,
      });
      return null;
    });
  try {
    return await Promise.race([capture, deadline]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * BT-202 overlay occlusion: hands the renderer a frozen frame for every tile
 * an overlay covers, then parks the native view offscreen once that frame is
 * on screen. Ownership is refcounted per overlay id so nested overlays
 * (command palette over a dialog) release in the right order.
 */
export class BrowserViewOverlay {
  private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  private readonly geometry: BrowserViewGeometry;
  private readonly send: BrowserViewSend;
  private readonly entryKeysByOwnerId = new Map<string, readonly string[]>();

  constructor(options: BrowserViewOverlayOptions) {
    this.entries = options.entries;
    this.geometry = options.geometry;
    this.send = options.send;
  }

  async occlude(
    windowId: string,
    input: BrowserViewOverlayOcclusion,
  ): Promise<BrowserViewOverlayOcclusionResult> {
    const previousKeyIds = this.entryKeysByOwnerId.get(input.overlayId) ?? [];
    const nextKeyIds = input.tiles.map((tile) =>
      entryKeyId({ ...tile, windowId }),
    );
    const nextKeyIdSet = new Set(nextKeyIds);
    const released = previousKeyIds.filter((keyId) => !nextKeyIdSet.has(keyId));
    const restoredTiles = this.releaseEntries(input.overlayId, released);
    this.entryKeysByOwnerId.set(input.overlayId, nextKeyIds);

    const results = await Promise.all(
      nextKeyIds.map((keyId) => this.occludeEntry(input.overlayId, keyId)),
    );

    // Counted from what each occlusion actually DID, never from the registry's
    // later state: a tile that attaches after `occludeEntry` missed it is
    // present by the time a post-await `hasSurfaceKey` runs, so counting there
    // reports a tile as occluded that this call never touched - and the
    // renderer, reading a full match, would never retry it.
    //
    // An overlay scan can race tile teardown. Log the all-missing case once
    // per scan rather than once per tile.
    const snapshots = results.map((result) => result.snapshot);
    const matchedCount = results.filter((result) => result.occluded).length;
    if (nextKeyIds.length > 0 && matchedCount === 0) {
      log.info("[browser-view] occlude for overlay: no matching entries", {
        overlayId: input.overlayId,
        requestedCount: nextKeyIds.length,
        matchedCount,
      });
    }

    return {
      snapshots: snapshots.filter(
        (snapshot): snapshot is BrowserViewOverlaySnapshot => snapshot !== null,
      ),
      restoredTiles,
      matchedCount,
    };
  }

  release(input: BrowserViewOverlayRelease): BrowserViewOverlayReleaseResult {
    const keyIds = this.entryKeysByOwnerId.get(input.overlayId) ?? [];
    this.entryKeysByOwnerId.delete(input.overlayId);
    return { restoredTiles: this.releaseEntries(input.overlayId, keyIds) };
  }

  /** Parks occluded native views only after their replacement frames paint. */
  paintAck(overlayId: string): void {
    const keyIds = this.entryKeysByOwnerId.get(overlayId) ?? [];
    for (const keyId of keyIds) {
      const entry = this.entries.getSurfaceByKey(keyId);
      if (entry === undefined) continue;
      if (!entry.overlayOwnerIds.includes(overlayId)) continue;
      if (!entry.overlayAwaitingPaintAck) continue;
      entry.overlayAwaitingPaintAck = false;
      entry.overlayParked = this.geometry.parkOffscreen(entry);
    }
  }

  invalidateSnapshot(entry: BrowserViewEntry, reason: string): void {
    if (entry.overlayOwnerIds.length === 0) return;
    // BT-202 fix (⌘K white-out): an overlay-parked view stays COMPOSITED on
    // purpose — that is what keeps its frame cache converging toward fresh
    // pixels — so per-frame paint churn under an open overlay must not flip
    // the displayed snapshot to stale. The renderer hides the frozen frame
    // entirely once stale, leaving only bg-background: exactly the blank
    // tile users saw behind the command palette. Content-level changes
    // (navigation, title, crash, load lifecycle) still invalidate.
    if (reason === "paint") return;
    if (!entry.overlaySnapshotStale) {
      entry.overlaySnapshotStale = true;
    }
    if (entry.surface === null) return;
    this.send(
      entry.surface.windowId,
      RunnerHostEvent.browserViewSnapshotInvalidated,
      { ...toTileKey(entry.surface), reason },
    );
  }

  /** Drops a detaching surface from every overlay it is still listed under. */
  forgetEntry(entry: BrowserViewEntry, keyId: string): void {
    for (const overlayId of entry.overlayOwnerIds) {
      const keys = this.entryKeysByOwnerId.get(overlayId) ?? [];
      this.entryKeysByOwnerId.set(
        overlayId,
        keys.filter((candidate) => candidate !== keyId),
      );
    }
    entry.overlayOwnerIds = [];
    entry.overlayAwaitingPaintAck = false;
    entry.overlayParked = false;
    // A pending restore wait (ticket 04) is addressed to a surface that is
    // going away; clearing the token tells `awaitRestoreFrame` its
    // eventual resolution is stale so it never notifies for a detached tile.
    // But the renderer's stand-in for THIS surface is still mounted and
    // waiting on that notification - if the surface itself is still here
    // (only re-keying, not a full detach), send it now so the wait's
    // cancellation cannot strand a frozen frame with no event ever coming.
    const hadPendingRestore = entry.overlayRestoreToken !== null;
    entry.overlayRestoreToken = null;
    if (hadPendingRestore && entry.surface !== null) {
      this.send(
        entry.surface.windowId,
        RunnerHostEvent.browserViewOverlayRestored,
        toTileKey(requireSurface(entry)),
      );
    }
  }

  /**
   * Follows a surface rebind so an open overlay keeps owning the same tile.
   * A pending restore wait (ticket 04) needs no handling here: it lives on
   * `entry.overlayRestoreToken`, so it carries across the rebind for free,
   * and `awaitRestoreFrame` addresses its eventual notification to the
   * entry's current surface - read after this rebind, whichever key it
   * settles under. (The manager's caller detaches the old frame-cache slot
   * separately, which itself unblocks a wait keyed to it rather than
   * stranding it on a subscription nothing will use again.)
   */
  rekeyEntry(
    entry: BrowserViewEntry,
    previousKeyId: string | null,
    nextKeyId: string,
  ): void {
    for (const overlayId of entry.overlayOwnerIds) {
      const overlayKeyIds = this.entryKeysByOwnerId.get(overlayId);
      if (overlayKeyIds === undefined) continue;
      this.entryKeysByOwnerId.set(
        overlayId,
        overlayKeyIds.map((keyId) =>
          previousKeyId !== null && keyId === previousKeyId ? nextKeyId : keyId,
        ),
      );
    }
  }

  dispose(): void {
    this.entryKeysByOwnerId.clear();
  }

  /**
   * Occludes one tile, reporting whether this overlay now owns it. `occluded`
   * is the retry signal the renderer reads: a tile already parked under
   * another overlay counts, a tile that was not there to park does not.
   */
  private async occludeEntry(
    overlayId: string,
    keyId: string,
  ): Promise<OccludeEntryResult> {
    const entry = this.entries.getSurfaceByKey(keyId);
    if (entry === undefined) return MISSED;
    if (entry.overlayOwnerIds.includes(overlayId)) return ALREADY_OCCLUDED;

    if (entry.overlayOwnerIds.length > 0) {
      // Already parked for another overlay; the view stays offscreen-visible
      // and no new pixels are needed.
      entry.overlayOwnerIds.push(overlayId);
      return ALREADY_OCCLUDED;
    }

    // A rapid release-then-reoccupy (this tile going owner count 0 -> 1
    // again before its restore wait settled) supersedes that wait: cancel it
    // so a late resolution cannot drop the stand-in this fresh occlusion is
    // about to replace anyway, mid-cycle.
    entry.overlayRestoreToken = null;

    // Invariant 6: capturePage() at swap time is the primary source for a
    // pixel-perfect, native-resolution stand-in. It is raced against a
    // ~2-frame deadline; only a capture that misses the deadline (or fails)
    // falls back to the rolling warm cache, with `stale` reporting whether
    // that cached frame is older than the freshness window.
    const raced = await raceCaptureAgainstDeadline(entry);
    let dataUrl: string | null;
    let stale = false;
    if (raced === CAPTURE_DEADLINE_ELAPSED || raced === null) {
      const cached = this.geometry.cachedFrame(keyId);
      dataUrl = cached?.dataUrl ?? null;
      stale = cached !== null && !this.geometry.isFrameFresh(keyId);
    } else {
      dataUrl = raced;
    }

    const activeKeyIds = this.entryKeysByOwnerId.get(overlayId) ?? [];
    if (!activeKeyIds.includes(keyId)) return MISSED;
    const currentEntry = this.entries.getSurfaceByKey(keyId);
    if (currentEntry === undefined) return MISSED;

    currentEntry.overlayOwnerIds.push(overlayId);
    currentEntry.overlaySnapshotStale = false;
    // BT-202 flicker fix: DO NOT park here. The native view must stay on
    // screen until the renderer has DECODED and PAINTED the replacement
    // frame — otherwise there is a guaranteed multi-frame window where the
    // page pixels are gone but nothing covers the tile yet (the reported
    // empty-state flash). The renderer acknowledges via `paintAck`
    // once img.decode() settles; only then do we move the view offscreen.
    currentEntry.overlayAwaitingPaintAck = true;
    return {
      occluded: true,
      snapshot: {
        ...toTileKey(requireSurface(currentEntry)),
        dataUrl,
        stale,
      },
    };
  }

  /**
   * Invariant 4 (restore edge, ticket 04): un-parks synchronously (step one)
   * and returns the tiles that never left the screen - those restore through
   * this synchronous return value, unchanged. A tile that WAS parked cannot
   * answer this way: the renderer's stand-in must stay mounted until the
   * restored view's first composited frame, which is necessarily later than
   * this call returns. Those go through `scheduleRestoreNotify` instead and
   * reach the renderer on the deferred `browserViewOverlayRestored` event.
   */
  private releaseEntries(
    overlayId: string,
    keyIds: readonly string[],
  ): BrowserViewTileKey[] {
    return keyIds
      .slice()
      .reverse()
      .flatMap((keyId): BrowserViewTileKey[] => {
        const entry = this.entries.getSurfaceByKey(keyId);
        if (entry === undefined) return [];
        entry.overlayOwnerIds = entry.overlayOwnerIds.filter(
          (ownerId) => ownerId !== overlayId,
        );
        if (entry.overlayOwnerIds.length > 0) {
          return [];
        }
        entry.overlaySnapshotStale = false;
        entry.overlayAwaitingPaintAck = false;
        const wasParked = entry.overlayParked;
        entry.overlayParked = false;
        // Step one: un-park immediately. The native view paints ABOVE the
        // stand-in (Electron composites a WebContentsView over the page), so
        // showing it first is visually atomic - nothing regresses before
        // step two removes the now-redundant stand-in.
        this.geometry.applyBounds(entry);
        this.geometry.applyVisibility(entry);
        if (!wasParked) {
          return [toTileKey(requireSurface(entry))];
        }
        this.scheduleRestoreNotify(entry, keyId);
        return [];
      });
  }

  /** Kicks off step two for one restored tile without blocking `release`/`occlude`. */
  private scheduleRestoreNotify(entry: BrowserViewEntry, keyId: string): void {
    const token = Symbol("overlay-restore");
    entry.overlayRestoreToken = token;
    void this.awaitRestoreFrame(entry, keyId, token);
  }

  /**
   * Waits for the restored view's first composited frame (or the liveness
   * escape) before telling the renderer to drop its stand-in. A token
   * mismatch on completion means `forgetEntry` cancelled this wait (surface
   * detached) or a newer release/rekey superseded it - either way, nothing
   * to notify.
   */
  private async awaitRestoreFrame(
    entry: BrowserViewEntry,
    keyId: string,
    token: symbol,
  ): Promise<void> {
    const nextFrame = this.geometry.awaitNextFrame(keyId);
    const path: RestorePath =
      nextFrame === null
        ? "no-subscription"
        : await raceRestoreFrameAgainstBudget(nextFrame);
    if (entry.overlayRestoreToken !== token) return;
    entry.overlayRestoreToken = null;
    if (entry.surface === null) return;
    // Replays any rect that streamed in during the wait window: `applyBounds`
    // swallows updates while `overlayRestoreToken` is set (see that guard),
    // so a resize mid-window would otherwise be lost. Idempotent - it
    // coalesces when nothing changed.
    this.geometry.applyBounds(entry);
    this.geometry.applyVisibility(entry);
    log.debug("[browser-view] overlay restore: stand-in drop", {
      keyId,
      path,
    });
    this.send(
      entry.surface.windowId,
      RunnerHostEvent.browserViewOverlayRestored,
      toTileKey(requireSurface(entry)),
    );
  }
}
