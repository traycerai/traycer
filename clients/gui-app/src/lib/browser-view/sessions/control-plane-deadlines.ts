/**
 * The viewer's half of the RTT-derived deadline table (ticket 18).
 *
 * The host measures the control-plane round trip - it is the end that can,
 * since the stream transport owns `ping`/`pong` on both sides of this contract
 * - and stamps its smoothed estimate on every `rttProbe` frame. This side
 * mirrors that one number into the three windows it owns. Nothing here
 * measures anything.
 *
 * Every entry is `max(floor, roundTrips x rtt)`, so a viewer that has seen no
 * probe (a PiP surface, a host too old to send one) runs on exactly the
 * literals these constants replaced. Measurement can lengthen a window, never
 * shorten it.
 */
import type { ControlPlaneDeadlineSpec } from "@traycer/protocol/host-transport/rtt-deadlines";

export const VIEWER_CONTROL_PLANE_DEADLINES = {
  /**
   * How long a buffered first click waits for the arm to land. The gesture is
   * replayed when `armed` returns, which is one mux round trip after the `arm`
   * that this press triggered; the host also awaits its input dispatcher's
   * activation inside that window, so a second round trip of headroom plus
   * jitter is what keeps the click. Below it, the click is silently discarded
   * and the user has to click twice (F3).
   */
  armBuffer: { floorMs: 1_000, roundTrips: 2.5 },
  /**
   * How long a round may hold a peer connection without a decoded frame. It
   * covers the whole negotiation the host deadlines at 4 round trips, plus the
   * media leg that follows it: ICE connectivity checks and the first frame
   * arriving and decoding. Six is that sum, and it must exceed the host's
   * negotiation window or this end would give up on rounds the host still
   * considers live.
   */
  firstFrame: { floorMs: 15_000, roundTrips: 6 },
  /**
   * No frame for this long means the tile is stale. On the JPEG plane a frame
   * is only produced after the previous one was acked, so the window has to
   * hold at least two full mint-to-ack round trips before silence can mean a
   * dead stream rather than a slow one; four leaves room for the repaint
   * between them.
   */
  staleWithoutFrame: { floorMs: 8_000, roundTrips: 4 },
} as const satisfies Readonly<Record<string, ControlPlaneDeadlineSpec>>;
