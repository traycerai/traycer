import type { ReactNode } from "react";
import { X } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { usePlatformBillingUrl } from "@/hooks/auth/use-platform-billing-url";
import { useVoiceMicrophoneSettingsMutation } from "@/hooks/voice/use-voice-session-mutations";
import { useOpenLink } from "@/lib/links/open-link";
import { cn } from "@/lib/utils";
import {
  useVoiceSessionStore,
  type VoiceEndReason,
  type VoiceRefusal,
} from "@/stores/voice/voice-session-store";

/**
 * Where the line is drawn: `row` in the window's top row in place of Talk, on
 * the row's own surface; `bar` as a band of its own under the phone's header.
 */
export type VoiceOutcomeLineSurface = "row" | "bar";

/**
 * The one line about how the last Talk went, with Dismiss: why a session ended,
 * or that one never began, which is not an ending. What the person can do about
 * it sits beside the words. Drawn by the strip on desktop and the bar on the
 * phone, where a session that ended in the background says so on return.
 */
export function VoiceOutcomeLine(props: {
  readonly surface: VoiceOutcomeLineSurface;
}): ReactNode {
  const refusal = useVoiceSessionStore((s) => s.refusal);
  const endReason = useVoiceSessionStore((s) => s.endReason);
  const clearRefusal = useVoiceSessionStore((s) => s.clearRefusal);
  const clearEndReason = useVoiceSessionStore((s) => s.clearEndReason);
  if (refusal !== null) {
    return (
      <OutcomeFrame
        state="refused"
        surface={props.surface}
        line={refusalLine(refusal)}
        onDismiss={clearRefusal}
      >
        {refusal === "credits" ? <GetCreditsButton /> : null}
        {refusal === "microphone-denied" ? <MicrophoneSettingsButton /> : null}
      </OutcomeFrame>
    );
  }
  if (endReason === null) return null;
  return (
    <OutcomeFrame
      state="ended"
      surface={props.surface}
      line={endedLine(endReason)}
      onDismiss={clearEndReason}
    >
      {endReason === "credits" ? <GetCreditsButton /> : null}
    </OutcomeFrame>
  );
}

function OutcomeFrame(props: {
  readonly state: "ended" | "refused";
  readonly surface: VoiceOutcomeLineSurface;
  readonly line: string;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <output
      data-testid="voice-session-strip"
      data-state={props.state}
      className={cn(
        "flex items-center gap-2 text-ui-xs text-muted-foreground",
        props.surface === "row"
          ? "min-w-0"
          : "w-full border-b border-border bg-background px-3 py-1.5",
      )}
    >
      <span className="min-w-0 flex-1 truncate" data-testid="voice-strip-state">
        {props.line}
      </span>
      {props.children}
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

/** The billing page of the account the app has selected. */
function GetCreditsButton(): ReactNode {
  const billingUrl = usePlatformBillingUrl();
  const openLink = useOpenLink();
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      data-testid="voice-strip-get-credits"
      onClick={(event) => void openLink(billingUrl, "account", event)}
    >
      Get credits
    </Button>
  );
}

/** A refused microphone's way out: the OS settings page, the only place it is undone. */
function MicrophoneSettingsButton(): ReactNode {
  const openSettings = useVoiceMicrophoneSettingsMutation();
  return (
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
  );
}

function refusalLine(refusal: VoiceRefusal): string {
  switch (refusal) {
    case "credits":
      return "Voice needs credits.";
    case "microphone":
      return "Voice did not start: the microphone is not available.";
    case "microphone-denied":
      return "Voice needs the microphone. Allow it in Settings.";
    case "unavailable":
      return "Voice did not start. Try again in a moment.";
  }
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
    case "playback":
      return "Voice ended: the sound could not be played.";
    case "ended":
      return "Voice ended.";
  }
}
