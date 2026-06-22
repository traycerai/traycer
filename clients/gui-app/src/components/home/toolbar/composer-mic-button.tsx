import { Mic, Square } from "lucide-react";
import { ToolbarIconButton } from "@/components/home/toolbar/toolbar-buttons";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import { DICTATION_ACTION_ID } from "@/hooks/composer/use-dictation-hotkey";
import type { DictationPreparingStatus } from "@/hooks/composer/use-dictation-availability";
import type { VoiceDictationState } from "@/hooks/composer/use-voice-dictation";

/**
 * Presentation-only control bundle the composer hands to the toolbar so the mic
 * button stays a dumb view over the dictation hook's state. The recording timer
 * + waveform live in the inline recording bar (`DictationRecordingBar`), which
 * replaces the toolbar row while recording, so the button itself only needs to
 * start dictation (and reflect state for a11y).
 */
export interface ComposerDictationControl {
  readonly state: VoiceDictationState;
  readonly onToggle: () => void;
  // Used by the inline recording bar (which replaces the toolbar while
  // recording); the mic button itself only needs `state` + `onToggle`.
  readonly onStop: () => void;
  readonly onCancel: () => void;
  readonly getStream: () => MediaStream | null;
}

function labelFor(state: VoiceDictationState): string {
  switch (state) {
    case "recording":
      return "Stop voice input";
    case "requesting":
      return "Starting voice input";
    case "transcribing":
      return "Transcribing";
    default:
      return "Start voice input";
  }
}

export function ComposerMicButton({
  control,
}: {
  readonly control: ComposerDictationControl;
}) {
  const { state, onToggle } = control;
  const isBusy = state === "requesting" || state === "transcribing";
  const isRecording = state === "recording";
  const label = labelFor(state);
  // Surface the (live, rebindable) shortcut in the tooltip when idle so it's
  // discoverable; omit it if the user has unbound the action.
  const boundChord = useBindingForAction(DICTATION_ACTION_ID);
  const hint = boundChord === null ? null : formatChordForDisplay(boundChord);
  const title =
    (state === "idle" || state === "error") && hint !== null
      ? `${label} (${hint})`
      : label;

  return (
    <ToolbarIconButton
      aria-label={label}
      title={title}
      aria-pressed={isRecording}
      onClick={onToggle}
      className={cn(
        isRecording &&
          "bg-destructive/15 text-destructive hover:bg-destructive/20 hover:text-destructive",
      )}
    >
      <MicButtonIcon isBusy={isBusy} isRecording={isRecording} />
    </ToolbarIconButton>
  );
}

function MicButtonIcon(props: {
  readonly isBusy: boolean;
  readonly isRecording: boolean;
}) {
  if (props.isBusy) return <MutedAgentSpinner />;
  if (props.isRecording) return <Square className="size-3.5 fill-current" />;
  return <Mic className="size-4" />;
}

function preparingLabel(status: DictationPreparingStatus): string {
  if (status.downloadState === "error") {
    return "Voice dictation setup failed - retrying";
  }
  if (status.downloadState === "downloading" && status.progress !== null) {
    return `Setting up voice dictation… ${Math.round(status.progress * 100)}%`;
  }
  return "Preparing voice input…";
}

// Mic icon wrapped in a circular progress ring. Determinate while downloading
// with known progress (the ring fills); indeterminate (a spinning arc) when the
// model is absent / progress is unknown / errored.
function MicProgressRing({ progress }: { readonly progress: number | null }) {
  const radius = 8.5;
  const circumference = 2 * Math.PI * radius;
  const determinate = progress !== null;
  const clamped = determinate ? Math.min(1, Math.max(0, progress)) : 0;
  return (
    <span className="relative inline-flex size-5 items-center justify-center">
      <svg
        viewBox="0 0 20 20"
        className={cn(
          "absolute inset-0 size-full -rotate-90",
          !determinate && "animate-spin",
        )}
        aria-hidden
      >
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth="2"
        />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={determinate ? circumference : circumference * 0.3}
          strokeDashoffset={determinate ? circumference * (1 - clamped) : 0}
        />
      </svg>
      <Mic className="size-3" />
    </span>
  );
}

/**
 * Disabled placeholder shown in the mic's slot while the on-device model is
 * still being readied, so the control doesn't silently vanish on first run: a
 * dimmed mic with a circular progress ring (fills as the model downloads).
 * Tooltip surfaces the live percentage.
 */
export function ComposerMicPreparing({
  status,
}: {
  readonly status: DictationPreparingStatus;
}) {
  const label = preparingLabel(status);
  const progress =
    status.downloadState === "downloading" ? status.progress : null;
  // A native `title` on a `disabled` button doesn't show on hover (the button
  // gets no pointer events). Put the tooltip on a wrapping span and make the
  // button `pointer-events-none` so the hover lands on the span.
  return (
    <span title={label} className="inline-flex">
      <ToolbarIconButton
        aria-label={label}
        disabled
        aria-busy
        className="pointer-events-none text-muted-foreground disabled:opacity-100"
      >
        <MicProgressRing progress={progress} />
      </ToolbarIconButton>
    </span>
  );
}
