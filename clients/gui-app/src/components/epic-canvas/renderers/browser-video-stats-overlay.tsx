import { useState } from "react";
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
 * Self-contained: reads only `ScreencastSession` and touches no controller
 * state. The `import.meta.env.DEV` gate lives at the CALL SITE
 * (`screencast-surface.tsx`) so esbuild eliminates the whole subtree in
 * production rather than keeping this module in the bundle.
 */
export function BrowserVideoStatsOverlay(props: {
  readonly session: ScreencastSession;
}) {
  const fps = useDecodedFps(props.session);
  const { video, videoStats } = props.session;

  return (
    <div className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1.5 py-1 font-mono text-[10px] leading-tight text-white">
      <div>plane: {videoPlaneLabel(video)}</div>
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
    </div>
  );
}

/** The three display states of the video plane, for the readout. */
function videoPlaneLabel(video: ScreencastSession["video"]): string {
  if (video.active) return "video";
  return video.media === null ? "off" : "negotiating";
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
 * fps from consecutive `framesDecoded` samples against the sampler's known
 * cadence (`STATS_SAMPLE_INTERVAL_MS` - a `setInterval`, not a measured gap),
 * derived during render rather than in an effect: `session.videoStats` already
 * IS the value this reacts to. A dev readout, not a frame-accurate meter.
 */
function useDecodedFps(session: ScreencastSession): number | null {
  const stats = session.videoStats;
  const [state, setState] = useState<DecodedFpsState>({ stats, fps: null });

  if (state.stats !== stats) {
    const decodedDelta =
      state.stats === null || stats === null
        ? null
        : stats.framesDecoded - state.stats.framesDecoded;
    setState({
      stats,
      fps:
        decodedDelta === null || decodedDelta < 0
          ? null
          : decodedDelta / (STATS_SAMPLE_INTERVAL_MS / 1000),
    });
  }

  return state.fps;
}
