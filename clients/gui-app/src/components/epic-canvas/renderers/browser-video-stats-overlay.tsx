import { useEffect, useState } from "react";
import type { ScreencastSession } from "@/lib/browser-view/sessions/use-screencast-session";
import { STATS_SAMPLE_INTERVAL_MS } from "@/lib/browser-view/sessions/video-plane-session";
import type { WebrtcVideoStatsSample } from "@/lib/browser-view/tiles/webrtc-media-registry";

/**
 * Dev-only per-tile stats readout (ticket 11, webrtc-display-plane spec §5
 * Instrumentation). There is no dev/debug settings flag anywhere in gui-app
 * to gate a UI affordance behind (only `import.meta.env.DEV`, the same
 * build-time check `traycer-app.tsx` already gates `ReactQueryDevtools`
 * behind), so this follows that precedent rather than inventing a new
 * user-facing setting.
 *
 * Self-contained: reads only `ScreencastSession`, adds its own pointer/frame
 * listeners on the session's existing refs, and touches no controller state.
 *
 * The `import.meta.env.DEV` gate lives at the CALL SITE
 * (`screencast-surface.tsx`), not here: this component's hooks run a ~30/s
 * `requestVideoFrameCallback` loop and a capture-phase `pointerdown`
 * listener per video tile, so gating inside the component would still pay
 * for that machinery in production (hooks run before any early return) and
 * would keep this module in the prod bundle regardless. Gating the JSX at
 * the mount site instead lets esbuild eliminate the whole subtree.
 */
export function BrowserVideoStatsOverlay(props: {
  readonly session: ScreencastSession;
}) {
  const inputEcho = useInputEchoProbe(props.session);
  const fps = useDecodedFps(props.session);
  const { video, videoStats } = props.session;

  return (
    <div className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1.5 py-1 font-mono text-[10px] leading-tight text-white">
      <div>plane: {video.mode}</div>
      <div>fps: {fps === null ? "-" : fps.toFixed(0)}</div>
      <div>drops: {videoStats === null ? "-" : videoStats.framesDropped}</div>
      <div>
        rtt:{" "}
        {videoStats === null
          ? "-"
          : `${videoStats.roundTripTimeMs.toFixed(0)}ms`}
      </div>
      <div>
        jitter:{" "}
        {videoStats === null ? "-" : `${videoStats.jitterMs.toFixed(1)}ms`}
      </div>
      <div>
        ice: {videoStats === null ? "-" : videoStats.iceCandidatePairType}
      </div>
      <div>g2g: {formatMs(videoStats?.glassToGlassMs ?? null)}</div>
      <div>dcRtt: {formatMs(videoStats?.dataChannelRttMs ?? null)}</div>
      <div>
        input→frame: {inputEcho === null ? "-" : `${inputEcho.toFixed(0)}ms`}
      </div>
    </div>
  );
}

/** `-` for a measurement this stream cannot produce; never a fabricated 0. */
function formatMs(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(0)}ms`;
}

interface DecodedFpsState {
  readonly stats: WebrtcVideoStatsSample | null;
  readonly fps: number | null;
}

/**
 * fps derived from consecutive `framesDecoded` samples rather than carried on
 * the wire sample itself, using the sampler's known cadence
 * (`STATS_SAMPLE_INTERVAL_MS`) rather than a wall-clock read between renders -
 * `Date.now()` is impure and not allowed in a render body, and the cadence is
 * exact anyway (a `setInterval`, not a measured gap). Fine for a dev readout,
 * not meant to be a frame-accurate meter.
 *
 * Computed during render (React's "adjusting state when a prop changes"
 * pattern), not in an effect - `session.videoStats` already IS the derived
 * value this hook reacts to, so a `useEffect` here would only add a second,
 * unnecessary render pass.
 */
function useDecodedFps(session: ScreencastSession): number | null {
  const stats = session.videoStats;
  const [state, setState] = useState<DecodedFpsState>({ stats, fps: null });

  if (state.stats !== stats) {
    setState({ stats, fps: nextFps(state.stats, stats) });
  }

  return state.fps;
}

function nextFps(
  previous: WebrtcVideoStatsSample | null,
  stats: WebrtcVideoStatsSample | null,
): number | null {
  if (stats === null || previous === null) return null;
  const decodedDelta = stats.framesDecoded - previous.framesDecoded;
  return decodedDelta < 0
    ? null
    : decodedDelta / (STATS_SAMPLE_INTERVAL_MS / 1000);
}

/**
 * Input->photon, stopped honestly (ticket 17): the frame that answers a click
 * is the first one CAPTURED after it, and the first frame merely *observed*
 * after it was captured before the click ever reached the host - it was
 * already in flight. Reading that one made every measurement a lower bound
 * on the wrong quantity (a decode interval, not a round trip).
 *
 * So the clock stops on `metadata.captureTime > pointerdown`, in
 * `performance.now()`'s domain - the same domain rVFC's timestamps live in,
 * which `Date.now()` is not. A stream with no `captureTime` (the Absolute
 * Capture Time extension absent) cannot answer this question at all, so the
 * readout stays `-` rather than showing a number it cannot stand behind.
 *
 * Wired with plain listeners on the session's existing refs rather than a
 * controller change - a true input->photon probe would need the controller's
 * dispatch seam, not just the DOM event.
 */
function useInputEchoProbe(session: ScreencastSession): number | null {
  const [delta, setDelta] = useState<number | null>(null);
  const { overlayButtonRef, videoRef } = session.refs;
  const videoActive = session.video.active;

  useEffect(() => {
    const button = overlayButtonRef.current;
    const video = videoRef.current;
    if (!videoActive || button === null || video === null) return;
    if (typeof video.requestVideoFrameCallback !== "function") return;

    let pendingSince: number | null = null;
    let frameHandle: number | null = null;

    const onFrame: VideoFrameRequestCallback = (now, metadata) => {
      const captureTime = metadata.captureTime;
      if (
        pendingSince !== null &&
        captureTime !== undefined &&
        captureTime > pendingSince
      ) {
        setDelta(now - pendingSince);
        pendingSince = null;
      }
      frameHandle = video.requestVideoFrameCallback(onFrame);
    };
    const onPointerDown = (): void => {
      pendingSince = performance.now();
    };

    button.addEventListener("pointerdown", onPointerDown, { capture: true });
    frameHandle = video.requestVideoFrameCallback(onFrame);
    return () => {
      button.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
      if (frameHandle !== null) video.cancelVideoFrameCallback(frameHandle);
    };
  }, [overlayButtonRef, videoActive, videoRef]);

  return delta;
}
