import type { ReactNode } from "react";
import { AudioLines } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

export const TALK_CONTROL_LABEL = "Talk";

/**
 * The "Talk" control beside the fixed Tracy entry in the tab strip (V6):
 * starts a voice session over the bot surface, and ends it while one is
 * live. Never in the composer, whose microphone stays "Dictate". Hidden
 * while the server answers the dormant mint (voice is off for this
 * deployment) and before the controller that owns the session is mounted.
 */
export function TalkControl(): ReactNode {
  const availability = useVoiceSessionStore((state) => state.availability);
  const phase = useVoiceSessionStore((state) => state.phase);
  const driver = useVoiceSessionStore((state) => state.driver);
  if (availability === "dormant" || driver === null) return null;
  const live = phase !== "idle";
  return (
    <TooltipWrapper
      label={
        live
          ? "End the voice session"
          : "Talk with your bots. Costs credits while on."
      }
      side="bottom"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant={live ? "success-ghost" : "ghost"}
        size="xs"
        aria-label={TALK_CONTROL_LABEL}
        aria-pressed={live}
        data-testid="voice-talk-control"
        data-state={phase}
        disabled={phase === "connecting" || phase === "ending"}
        onClick={() => {
          if (live) driver.end();
          else driver.start();
        }}
        className="shrink-0 self-center [-webkit-app-region:no-drag]"
      >
        <AudioLines aria-hidden="true" />
        {TALK_CONTROL_LABEL}
      </Button>
    </TooltipWrapper>
  );
}
