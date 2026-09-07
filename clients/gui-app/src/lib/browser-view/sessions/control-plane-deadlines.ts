/** The viewer's half of the RTT-derived deadline table (ticket 18). */
import type { ControlPlaneDeadlineSpec } from "@traycer/protocol/host-transport/rtt-deadlines";

export const VIEWER_CONTROL_PLANE_DEADLINES = {
  /**
   * How long a buffered first click waits for the arm to land.
   * The gesture is replayed when `armed` returns, which is one mux round trip after the `arm` that this press triggered; the host also awaits its input dispatcher's activation inside that window, so a second round trip of headroom plus jitter is what keeps the.
   */
  armBuffer: { floorMs: 1_000, roundTrips: 2.5 },
  /**
   * How long a round may hold a peer connection without a decoded frame.
   * It covers the whole negotiation the host deadlines at 4 round trips, plus the media leg that follows it: ICE connectivity checks and the first frame arriving and decoding.
   */
  firstFrame: { floorMs: 15_000, roundTrips: 6 },
  /**
   * No frame for this long means the tile is stale.
   * On the JPEG plane a frame is only produced after the previous one was acked, so the window has to hold at least two full mint-to-ack round trips before silence can mean a dead stream rather than a slow one; four leaves room for the repaint between them.
   */
  staleWithoutFrame: { floorMs: 8_000, roundTrips: 4 },
} as const satisfies Readonly<Record<string, ControlPlaneDeadlineSpec>>;
