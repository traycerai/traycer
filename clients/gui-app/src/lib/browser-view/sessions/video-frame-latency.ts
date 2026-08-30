/**
 * Glass-to-glass latency, read off the `requestVideoFrameCallback` metadata
 * the decode loop already receives (ticket 17, F7).
 *
 * `VideoFrameCallbackMetadata` carries three timestamps in the RECEIVER's
 * `performance.now()` clock domain:
 *
 * ```
 *   captureTime ──── network + jitter buffer ────▶ receiveTime
 *   receiveTime ──── decode + composite ─────────▶ expectedDisplayTime
 *   captureTime ──── the whole trip (glass to glass) ─▶ expectedDisplayTime
 * ```
 *
 * `captureTime` is the SENDER's capture instant, translated into this clock by
 * the Absolute Capture Time RTP header extension. Chromium negotiates that
 * extension by default, which is not the same as guaranteeing it: a peer that
 * strips it, or a WebView with no per-frame callback at all, leaves the field
 * `undefined`. `receiveTime` is likewise optional. So every derived value is
 * independently optional, and a missing input yields `null` - never a `NaN`
 * that would fail the wire's `nonnegative()` parse at the next cadence tick.
 *
 * Aggregation is a fixed-size ring of the last {@link LATENCY_WINDOW_SIZE}
 * frames: at ~30fps the 5s stats cadence sees ~150 frames, so the window is
 * roughly the trailing two seconds. Percentiles are nearest-rank over a copy,
 * which costs one 64-element sort per cadence tick and nothing per frame.
 */

/** Deliberately small - see the module comment; this is a sample, not a history. */
export const LATENCY_WINDOW_SIZE = 64;

/** One frame's derived timings; each independently `null` when its inputs are absent. */
export interface VideoFrameLatencySample {
  readonly glassToGlassMs: number | null;
  readonly networkPlusJitterMs: number | null;
  readonly decodeCompositeMs: number | null;
}

/** What the stats cadence reports: the window's median, plus the tail of the whole trip. */
export interface VideoFrameLatencySummary {
  readonly glassToGlassMs: number | null;
  readonly glassToGlassP95Ms: number | null;
  readonly networkPlusJitterMs: number | null;
  readonly decodeCompositeMs: number | null;
}

export interface VideoFrameLatencyWindow {
  /** One decoded frame. `null` metadata (no rVFC on this WebView) is ignored. */
  note(metadata: VideoFrameCallbackMetadata | null): void;
  summarize(): VideoFrameLatencySummary;
}

/**
 * A difference of two clock readings, or `null`. Rejects a missing endpoint,
 * a non-finite reading, and a negative result - the last is not merely
 * unrepresentable on the wire, it means the two timestamps did not come from
 * the same clock domain (a peer that stamped `captureTime` without the
 * extension's translation), and a clamp to zero would report that as a
 * suspiciously perfect measurement instead of as no measurement.
 */
function elapsed(
  from: number | undefined,
  to: number | undefined,
): number | null {
  if (from === undefined || to === undefined) return null;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const delta = to - from;
  return delta >= 0 ? delta : null;
}

export function readVideoFrameLatency(
  metadata: VideoFrameCallbackMetadata,
): VideoFrameLatencySample {
  return {
    glassToGlassMs: elapsed(metadata.captureTime, metadata.expectedDisplayTime),
    networkPlusJitterMs: elapsed(metadata.captureTime, metadata.receiveTime),
    decodeCompositeMs: elapsed(
      metadata.receiveTime,
      metadata.expectedDisplayTime,
    ),
  };
}

/** Nearest-rank percentile over the finite samples; `null` when there are none. */
function percentile(
  samples: readonly (number | null)[],
  fraction: number,
): number | null {
  const values = samples.filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const rank = Math.ceil(fraction * values.length) - 1;
  return values[Math.min(Math.max(rank, 0), values.length - 1)] ?? null;
}

export function createVideoFrameLatencyWindow(): VideoFrameLatencyWindow {
  const samples: VideoFrameLatencySample[] = [];

  return {
    note: (metadata) => {
      if (metadata === null) return;
      const sample = readVideoFrameLatency(metadata);
      if (
        sample.glassToGlassMs === null &&
        sample.networkPlusJitterMs === null &&
        sample.decodeCompositeMs === null
      ) {
        // Nothing derivable - keeping it would only dilute the window.
        return;
      }
      samples.push(sample);
      if (samples.length > LATENCY_WINDOW_SIZE) samples.shift();
    },
    summarize: () => {
      const glassToGlass = samples.map((sample) => sample.glassToGlassMs);
      return {
        glassToGlassMs: percentile(glassToGlass, 0.5),
        glassToGlassP95Ms: percentile(glassToGlass, 0.95),
        networkPlusJitterMs: percentile(
          samples.map((sample) => sample.networkPlusJitterMs),
          0.5,
        ),
        decodeCompositeMs: percentile(
          samples.map((sample) => sample.decodeCompositeMs),
          0.5,
        ),
      };
    },
  };
}
