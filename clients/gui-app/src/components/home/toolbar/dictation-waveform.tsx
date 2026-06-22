import { useEffect, useRef, type ReactNode } from "react";
import WaveSurfer from "wavesurfer.js";
import RecordPlugin from "wavesurfer.js/plugins/record";
import { cn } from "@/lib/utils";

// Seconds of audio visible in the scrolling window.
const SCROLL_WINDOW_SECONDS = 4;
const BAR_WIDTH = 2;
const BAR_GAP = 2;
const BAR_RADIUS = 2;
// Purely-visual vertical scaling. AGC'd speech peaks only reach ~0.1–0.3 of full
// scale, so without this the bars look tiny; this exaggerates them for the
// visualization only (it does not touch the captured audio). Bars still clamp at
// the canvas height for loud input.
const BAR_HEIGHT_SCALE = 4;

interface DictationWaveformProps {
  readonly getStream: () => MediaStream | null;
  readonly className: string | undefined;
}

/**
 * Live scrolling dictation waveform, rendered by wavesurfer.js's RecordPlugin
 * straight from the capture MediaStream. The browser's noise suppression keeps
 * silence flat and AGC normalizes speech, so the library just renders amplitude
 * - no custom gating/auto-gain. RecordPlugin owns its own AudioContext tap on
 * the stream; we keep the stream alive for STT separately.
 */
export function DictationWaveform({
  getStream,
  className,
}: DictationWaveformProps): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    // wavesurfer paints its own canvas (no CSS inheritance), so resolve the bar
    // color from the container's computed `color` (set by a `text-*` class).
    const waveColor = getComputedStyle(container).color;

    const ws = WaveSurfer.create({
      container,
      height: "auto",
      waveColor,
      progressColor: waveColor,
      cursorWidth: 0,
      barWidth: BAR_WIDTH,
      barGap: BAR_GAP,
      barRadius: BAR_RADIUS,
      barHeight: BAR_HEIGHT_SCALE,
      interact: false,
    });
    const record = ws.registerPlugin(
      RecordPlugin.create({
        scrollingWaveform: true,
        scrollingWaveformWindow: SCROLL_WINDOW_SECONDS,
        renderRecordedAudio: false,
      }),
    );

    let micStream: { onDestroy: () => void } | null = null;
    let raf = 0;
    let disposed = false;
    // The capture stream is set a beat after recording begins; attach the
    // visualizer once it's live.
    const attach = (): void => {
      if (disposed) return;
      const stream = getStream();
      if (stream === null) {
        raf = requestAnimationFrame(attach);
        return;
      }
      micStream = record.renderMicStream(stream);
    };
    attach();

    return () => {
      disposed = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      micStream?.onDestroy();
      ws.destroy();
    };
  }, [getStream]);

  return (
    <div
      ref={containerRef}
      className={cn("h-full w-full", className)}
      aria-hidden
    />
  );
}
