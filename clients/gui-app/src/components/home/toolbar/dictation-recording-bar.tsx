import { useEffect, useRef, useState, type ReactNode } from "react";
import { Square, X } from "lucide-react";
import { DictationWaveform } from "@/components/home/toolbar/dictation-waveform";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type { VoiceDictationState } from "@/hooks/composer/use-voice-dictation";

interface DictationRecordingBarProps {
  readonly state: VoiceDictationState;
  readonly getStream: () => MediaStream | null;
  readonly onStop: () => void;
  readonly onCancel: () => void;
}

/**
 * Inline recording strip that occupies the composer's bottom toolbar row
 * (Codex-style): a live scrolling waveform + elapsed timer + cancel/stop that
 * replaces the normal toolbar controls while dictation is active. The text
 * editor above stays visible - this never covers the composer.
 */
export function DictationRecordingBar(
  props: DictationRecordingBarProps,
): ReactNode {
  const { state, getStream, onStop, onCancel } = props;
  if (state === "transcribing") {
    return (
      <div className="flex w-full min-w-0 items-center gap-2">
        <span className="inline-flex items-center gap-2 text-ui-sm text-muted-foreground">
          <MutedAgentSpinner />
          Transcribing…
        </span>
      </div>
    );
  }
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <RecordingControls
        getStream={getStream}
        onStop={onStop}
        onCancel={onCancel}
      />
    </div>
  );
}

function RecordingControls({
  getStream,
  onStop,
  onCancel,
}: {
  readonly getStream: () => MediaStream | null;
  readonly onStop: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const elapsed = useElapsedSeconds();
  return (
    <>
      <span className="inline-flex shrink-0 items-center gap-1.5 text-ui-xs tabular-nums text-destructive">
        <span
          className="size-1.5 animate-pulse rounded-full bg-destructive"
          aria-hidden
        />
        {formatElapsed(elapsed)}
      </span>
      <div className="h-7 min-w-0 flex-1 text-primary">
        <DictationWaveform getStream={getStream} className={undefined} />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        onClick={onCancel}
        aria-label="Cancel voice input"
        title="Cancel (Esc)"
      >
        <X className="size-4" />
      </Button>
      <Button
        type="button"
        size="sm"
        className="h-7 shrink-0 gap-1.5"
        onClick={onStop}
        aria-label="Stop and insert transcript"
        title="Stop and insert"
      >
        <Square className="size-3 fill-current" />
        Stop
      </Button>
    </>
  );
}

// Counts up from mount. The controls mount exactly when recording starts, so the
// elapsed value is the recording duration. State is set only from async ticks
// (never synchronously in the effect body) to avoid cascading renders; a 0ms
// first tick shows 0:00 immediately.
function useElapsedSeconds(): number {
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef(0);
  useEffect(() => {
    startedAtRef.current = Date.now();
    const tick = (): void => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    };
    const firstTick = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 250);
    return () => {
      window.clearTimeout(firstTick);
      window.clearInterval(id);
    };
  }, []);
  return elapsed;
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
