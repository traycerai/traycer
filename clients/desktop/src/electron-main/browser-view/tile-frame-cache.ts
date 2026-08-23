/**
 * BT-201: rolling single-slot frame cache for a native browser tile.
 *
 * The overlay system needs pixels the instant a popover crosses a tile
 * (ADR 0001 R2). Cold `capturePage` costs an IPC hop plus a compositor read,
 * which shows up as a visible blank/stale flash. Instead, while a tile is
 * visible we keep a frame subscription running and retain only the most
 * recently encoded frame per tile; occlusion then paints from this slot with
 * zero capture cost.
 *
 * Deliberate properties:
 *  - One slot per tile, no history: memory is bounded by open tiles.
 *  - Throttled encode: frames arrive at compositor rate; we accept at most
 *    one per `minIntervalMs` so a busy page cannot flood the main process
 *    with JPEG encodes.
 *  - Downscaled before encode: `maxDimension` caps the long edge; occlusion
 *    snapshots never need native resolution.
 *  - While an occlusion is active the view is parked offscreen-but-visible
 *    (BT-202), so the compositor keeps producing frames and the slot keeps
 *    converging toward fresh content under long-lived menus.
 *
 * Images are typed STRUCTURALLY (`TileFrameImage`) rather than as Electron's
 * `NativeImage`: the module stays electron-import-free and unit-testable,
 * and real `NativeImage` instances satisfy the shape at the wiring site.
 */

export const TILE_FRAME_MIN_INTERVAL_MS = 75;
export const TILE_FRAME_STALE_AFTER_MS = 250;
export const TILE_FRAME_MAX_DIMENSION = 1600;
export const TILE_FRAME_JPEG_QUALITY = 80;
/** BT-205: subscription ceiling; overflow evicts least-recently-accepted. */
export const TILE_FRAME_MAX_ATTACHED = 12;

export interface TileFrameImage {
  isEmpty(): boolean;
  getSize(): { readonly width: number; readonly height: number };
  /** Matches Electron capture results, which return plain Uint8Array. */
  toJPEG(quality: number): Uint8Array;
}

/**
 * Downscale support is OPTIONAL so the minimal contract matches Electron's
 * `capturePage` result structurally; frame sources backed by `NativeImage`
 * (real frame subscriptions) provide `resize` and get long-edge capping,
 * while bare capture results fall through un-scaled.
 */
export interface ScalableTileFrameImage extends TileFrameImage {
  resize(options: {
    readonly width: number;
    readonly height: number;
  }): TileFrameImage;
}

export interface TileFrameCacheWebContents {
  beginFrameSubscription(callback: (image: TileFrameImage) => void): void;
  endFrameSubscription(): void;
}

export interface EncodedTileFrame {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

export type TileFrameEncoder = (
  image: TileFrameImage,
) => EncodedTileFrame | null;

export interface TileFrameCacheOptions {
  /** Minimum gap between accepted (encoded) frames, in milliseconds. */
  readonly minIntervalMs: number;
  /** A slot older than this many milliseconds counts as stale. */
  readonly staleAfterMs: number;
  /** Long-edge cap applied to every cached frame. */
  readonly maxDimension: number;
  /** JPEG quality used by the default encoder. */
  readonly jpegQuality: number;
  /**
   * Hard cap on concurrently subscribed tiles (BT-205). Overflow evicts the
   * least-recently-accepted slot; never-accepted slots are evicted first.
   */
  readonly maxAttached: number;
  /** Notified when the cap forces an eviction. */
  readonly onEvict: (key: string) => void;
  /** Injectable clock, milliseconds. */
  readonly now: () => number;
  /**
   * Injectable encoder. Defaults to NativeImage → downscaled JPEG data URL.
   * Tests substitute pure fakes here.
   */
  readonly encode: TileFrameEncoder;
}

export interface TileFrameStats {
  readonly attached: number;
  readonly framesAccepted: number;
  readonly framesSkipped: number;
  readonly emptyFrames: number;
  readonly encodeFailures: number;
}

export function defaultTileFrameEncoder(
  jpegQuality: number,
  maxDimension: number,
): TileFrameEncoder {
  return (image) => {
    if (image.isEmpty()) return null;
    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0) return null;
    let encoded: TileFrameImage = image;
    const longEdge = Math.max(size.width, size.height);
    const maybeResize = (image as Partial<ScalableTileFrameImage>).resize;
    if (longEdge > maxDimension && typeof maybeResize === "function") {
      const scale = maxDimension / longEdge;
      encoded = maybeResize.call(image, {
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      });
      if (encoded.isEmpty()) return null;
    }
    const buffer = Buffer.from(encoded.toJPEG(jpegQuality));
    if (buffer.length === 0) return null;
    const scaledSize = encoded.getSize();
    return {
      dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
      width: scaledSize.width,
      height: scaledSize.height,
    };
  };
}

interface TileFrameSlot {
  detach: () => void;
  lastAcceptedAtMs: number;
  frame: EncodedTileFrame | null;
}

export class TileFrameCache {
  private readonly slots = new Map<string, TileFrameSlot>();
  private framesAccepted = 0;
  private framesSkipped = 0;
  private emptyFrames = 0;
  private encodeFailures = 0;

  constructor(private readonly options: TileFrameCacheOptions) {}

  attach(key: string, webContents: TileFrameCacheWebContents): void {
    if (this.slots.has(key)) return;
    this.evictOverflowFor(key);
    const onFrame = (image: TileFrameImage): void => {
      this.handleFrame(key, image);
    };
    webContents.beginFrameSubscription(onFrame);
    const slot: TileFrameSlot = {
      detach: () => {
        try {
          webContents.endFrameSubscription();
        } catch {
          // A destroyed guest can reject the unsubscribe; the subscription
          // dies with the process either way.
        }
        this.slots.delete(key);
      },
      lastAcceptedAtMs: Number.NEGATIVE_INFINITY,
      frame: null,
    };
    this.slots.set(key, slot);
  }

  detach(key: string): void {
    this.slots.get(key)?.detach();
  }

  detachAll(): void {
    for (const key of Array.from(this.slots.keys())) {
      this.detach(key);
    }
  }

  get(key: string): EncodedTileFrame | null {
    return this.slots.get(key)?.frame ?? null;
  }

  ageMs(key: string): number | null {
    const slot = this.slots.get(key);
    if (slot === undefined || slot.frame === null) return null;
    return Math.max(0, this.options.now() - slot.lastAcceptedAtMs);
  }

  isFresh(key: string): boolean {
    const age = this.ageMs(key);
    return age !== null && age <= this.options.staleAfterMs;
  }

  has(key: string): boolean {
    return this.slots.has(key);
  }

  stats(): TileFrameStats {
    return {
      attached: this.slots.size,
      framesAccepted: this.framesAccepted,
      framesSkipped: this.framesSkipped,
      emptyFrames: this.emptyFrames,
      encodeFailures: this.encodeFailures,
    };
  }

  /**
   * BT-205: enforce the subscription cap before inserting. Victims are the
   * least-recently-accepted slots (never-accepted count as oldest), so a
   * live tile being watched right now is always the last to go.
   */
  private evictOverflowFor(incomingKey: string): void {
    while (this.slots.size >= this.options.maxAttached) {
      let victimKey: string | null = null;
      let victimAcceptedAt = Number.POSITIVE_INFINITY;
      for (const [key, slot] of this.slots) {
        if (key === incomingKey) continue;
        if (slot.lastAcceptedAtMs < victimAcceptedAt) {
          victimAcceptedAt = slot.lastAcceptedAtMs;
          victimKey = key;
        }
      }
      if (victimKey === null) break;
      const victim = victimKey;
      this.detach(victim);
      this.options.onEvict(victim);
    }
  }

  private handleFrame(key: string, image: TileFrameImage): void {    const slot = this.slots.get(key);
    if (slot === undefined) return;
    if (image.isEmpty()) {
      this.emptyFrames += 1;
      return;
    }
    const nowMs = this.options.now();
    if (
      slot.frame !== null &&
      nowMs - slot.lastAcceptedAtMs < this.options.minIntervalMs
    ) {
      this.framesSkipped += 1;
      return;
    }
    const encoded = this.options.encode(image);
    if (encoded === null) {
      this.encodeFailures += 1;
      return;
    }
    slot.frame = encoded;
    slot.lastAcceptedAtMs = nowMs;
    this.framesAccepted += 1;
  }
}
