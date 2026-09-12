import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import { BrowserScreencastStreamClient } from "@traycer-clients/shared/host-transport/browser-screencast-stream-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * The mirror's CSS extent, which {@link pipHeadlessFrameBudget} multiplies by
 * the viewer's device ratio. These are the geometry ceiling from
 * `pip-geometry.ts`, restated here so the frame request and the surface it
 * paints into cannot drift apart.
 */
export const PIP_HEADLESS_CSS_WIDTH = 480;
export const PIP_HEADLESS_CSS_HEIGHT = 360;

/**
 * A mirror is small and glanced at, not read, so it can afford a lower
 * quantizer than a full tile - but not the resolution loss that a ratio of 1
 * was silently costing it. On any 2x display the frames were arriving at half
 * the surface's real pixel count and being upscaled to fit.
 */
export const PIP_HEADLESS_QUALITY = 82;

/**
 * Two is the ceiling rather than three: this surface is a few hundred CSS
 * pixels across, and the step from 2x to 3x quadruples nothing a viewer can
 * see at that size while tripling the bytes each frame costs.
 */
const PIP_HEADLESS_MAX_RATIO = 2;

export interface PipHeadlessFrameBudget {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
  readonly deviceScaleFactor: number;
}

/** The frame budget for a mirror on a display of `devicePixelRatio`. */
export function pipHeadlessFrameBudget(
  devicePixelRatio: number,
): PipHeadlessFrameBudget {
  const ratio = Number.isFinite(devicePixelRatio)
    ? Math.min(PIP_HEADLESS_MAX_RATIO, Math.max(1, devicePixelRatio))
    : 1;
  return {
    maxWidth: Math.ceil(PIP_HEADLESS_CSS_WIDTH * ratio),
    maxHeight: Math.ceil(PIP_HEADLESS_CSS_HEIGHT * ratio),
    quality: PIP_HEADLESS_QUALITY,
    deviceScaleFactor: ratio,
  };
}

/** The budget for the display this document is on. */
export function currentPipHeadlessFrameBudget(): PipHeadlessFrameBudget {
  return pipHeadlessFrameBudget(
    typeof window === "undefined" ? 1 : window.devicePixelRatio,
  );
}

interface PipHeadlessStreamHandle {
  close(): void;
}

/**
 * Same transport as the peek tile, without visibility registration, input
 * arming, or tile-open resume. A mirror has nothing to wait for, so it acks
 * on arrival rather than after paint.
 */
export function openPipHeadlessStream(input: {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
  readonly onFrame: (
    frame: BrowserScreencastServerFrame,
    jpegBytes: Uint8Array | null,
  ) => void;
}): PipHeadlessStreamHandle {
  const stream = new BrowserScreencastStreamClient({
    wsStreamClient: input.client,
    // Epic-scoped like the fleet that opens it - see `pip-epic-sessions`.
    scope: { kind: "epic", epicId: input.epicId },
    sessionId: input.sessionId,
    tabId: input.tabId,
    maxWidth: input.maxWidth,
    maxHeight: input.maxHeight,
    quality: input.quality,
    format: "jpeg",
    role: "pip",
    // A mirror of a tab some tile is already showing, never the viewer an
    // open was made for; the tile presents the token.
    handoffToken: null,
    callbacks: {
      onServerFrame: (frame, jpegBytes) => {
        // Answered before anything else: the host times this reply, so any
        // work in between is measured as link latency - and a mirror that
        // never answers reads as a dead link.
        if (frame.kind === "rttProbe") {
          stream.sendClientFrame({
            kind: "rttProbeAck",
            hasBinaryPayload: false,
            probeId: frame.probeId,
          });
          return;
        }
        input.onFrame(frame, jpegBytes);
        if (frame.kind !== "frame") return;
        stream.sendClientFrame({
          kind: "ack",
          hasBinaryPayload: false,
          sequence: frame.sequence,
        });
      },
      onConnectionStatus: () => undefined,
    },
  });
  return {
    close: () => {
      stream.close();
    },
  };
}
