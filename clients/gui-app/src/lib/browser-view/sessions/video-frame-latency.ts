/**
 * Glass-to-glass latency, read off the `requestVideoFrameCallback` metadata the decode loop already receives (ticket 17, F7).
 */

/** Deliberately small - see the module comment; this is a sample, not a history. */
export const LATENCY_WINDOW_SIZE = 64;

/** What the stats cadence reports: the window's medians, plus the tail of the whole trip. */
interface VideoFrameLatencySummary {
  readonly glassToGlassMs: number | null;
  readonly glassToGlassP95Ms: number | null;
  readonly networkPlusJitterMs: number | null;
  readonly decodeCompositeMs: number | null;
}

/** One frame's derived timings - the same three legs, before any aggregation. */
type VideoFrameLatencySample = Omit<
  VideoFrameLatencySummary,
  "glassToGlassP95Ms"
>;

interface VideoFrameLatencyWindow {
  /** One decoded frame. `null` metadata (no rVFC on this WebView) is ignored. */
  note(metadata: VideoFrameCallbackMetadata | null): void;
  summarize(): VideoFrameLatencySummary;
}

/**
 * A difference of two clock readings, or `null`.
 * Rejects a missing endpoint, a non-finite reading, and a negative result - the last is not merely unrepresentable on the wire, it means the two timestamps did not come from the same clock domain (a peer that stamped `captureTime` without the extension's.
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
