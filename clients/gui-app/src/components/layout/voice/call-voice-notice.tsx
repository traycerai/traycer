import type { ReactNode } from "react";
import { callVoiceLabel } from "@/lib/voice/call-voice";
import {
  useVoiceSessionStore,
  type CallVoiceNotice as Notice,
} from "@/stores/voice/voice-session-store";

/**
 * What the call in progress says about its voice, when there is something to
 * say: the saved voice is not offered so the default speaks, or the
 * connection offers no choice of voice at all. Drawn beside the call's
 * controls while it connects or runs.
 */
export function CallVoiceNotice(): ReactNode {
  const notice = useVoiceSessionStore((s) =>
    s.phase === "connecting" || s.phase === "live" ? s.voiceNotice : null,
  );
  if (notice === null) return null;
  return (
    <p
      role="status"
      data-testid="call-voice-notice"
      className="px-1 text-ui-xs text-muted-foreground"
    >
      {noticeLine(notice)}
    </p>
  );
}

function noticeLine(notice: Notice): string {
  switch (notice.kind) {
    case "fallback":
      return `${callVoiceLabel(notice.saved)} is unavailable. This call uses ${callVoiceLabel(notice.voice)}.`;
    case "legacy":
      return "This connection uses the default voice; it may change when reconnecting.";
  }
}
