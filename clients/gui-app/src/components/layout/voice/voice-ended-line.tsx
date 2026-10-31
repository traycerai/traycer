import type { ReactNode } from "react";
import { X } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useVoiceMicrophoneSettingsMutation } from "@/hooks/voice/use-voice-session-mutations";
import type { VoiceEndReason } from "@/stores/voice/voice-session-store";

/**
 * The one line that says why the last voice session ended, with Dismiss.
 * A refused microphone also offers the OS settings page, the only place the
 * refusal is undone. Drawn by the strip on desktop and the bar on the phone,
 * where a session that ended in the background says so on return.
 */
export function VoiceEndedLine(props: {
  readonly reason: VoiceEndReason;
  readonly onDismiss: () => void;
}): ReactNode {
  const openSettings = useVoiceMicrophoneSettingsMutation();
  return (
    <output
      data-testid="voice-session-strip"
      data-state="ended"
      className="flex w-full items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-ui-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1" data-testid="voice-strip-state">
        {endedLine(props.reason)}
      </span>
      {props.reason === "microphone-denied" ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          data-testid="voice-strip-microphone-settings"
          disabled={openSettings.isPending}
          onClick={() => openSettings.mutate()}
        >
          Open Settings
          {openSettings.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        data-testid="voice-strip-dismiss"
        onClick={props.onDismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </output>
  );
}

function endedLine(reason: VoiceEndReason): string {
  switch (reason) {
    case "credits":
      return "Voice ended: credits.";
    case "connection":
      return "Voice ended: connection lost.";
    case "locked":
      return "Voice ended: the screen locked.";
    case "background":
      return "Voice ended when you left the app.";
    case "interrupted":
      return "Voice ended: a call or another app took the microphone.";
    case "microphone":
      return "Voice did not start: the microphone is not available.";
    case "microphone-denied":
      return "Voice needs the microphone. Allow it in Settings.";
    case "playback":
      return "Voice ended: the sound could not be played.";
    case "unavailable":
      return "Voice did not start. Try again in a moment.";
    case "ended":
      return "Voice ended.";
  }
}
