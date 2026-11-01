import { useEffect, type ReactNode } from "react";
import { AudioLines } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { ACTION_META } from "@/lib/keybindings/actions";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { isMobileApp } from "@/lib/mobile-app";
import {
  talkToggleAction,
  useVoiceSessionStore,
} from "@/stores/voice/voice-session-store";

export const TALK_CONTROL_LABEL = "Talk";

/**
 * Talk's toggle, shared by the control and the `voice.talk.toggle` shortcut:
 * starts a session when none runs and Talk could start one, and ends one
 * that is connecting or live. Dictation is a separate action and is never
 * touched here.
 */
function toggleTalk(): void {
  const state = useVoiceSessionStore.getState();
  const action = talkToggleAction(state);
  if (action === "end") state.driver?.end();
  else if (action === "start") state.driver?.start();
}

/**
 * Registers Talk's shortcut with the keybinding registry, mounted with the
 * controller that owns the session. The handler reads the store when it
 * fires, so it is registered once.
 */
export function TalkShortcutBridge(): ReactNode {
  useEffect(() => {
    if (ACTION_META["voice.talk.toggle"].desktopOnly && isMobileApp()) {
      return undefined;
    }
    return registerDynamicActionHandler("voice.talk.toggle", toggleTalk);
  }, []);
  return null;
}

/**
 * How Talk is drawn: the glyph with its name (`label`), the glyph alone in
 * a strip's box (`glyph`), or the glyph alone in a box a finger can find
 * (`touch`, the phone's channel header).
 */
export type TalkControlForm = "label" | "glyph" | "touch";

const TALK_CONTROL_SIZE = {
  label: "xs",
  glyph: "icon-xs",
  touch: "icon-sm",
} as const satisfies Record<TalkControlForm, string>;

/**
 * The "Talk" control beside the fixed Tracy entry in the tab strip (V6),
 * wherever the strip is: beside the entry in the header strip, under it in
 * the vertical strip, the glyph alone in the collapsed rail; on the phone,
 * in every bot channel's header, the Tracy tab's included (V5).
 * Starts a voice session over the bot surface, and ends it while one is
 * live. Never in the composer, whose microphone stays "Dictate". Hidden
 * until the server says this deployment offers voice (and again when a mint
 * answers dormant), and before the controller that owns the session is
 * mounted.
 */
export function TalkControl(props: {
  /** The glyph alone outside `label`; the label stays its name. */
  readonly form: TalkControlForm;
}): ReactNode {
  const availability = useVoiceSessionStore((state) => state.availability);
  const phase = useVoiceSessionStore((state) => state.phase);
  const driver = useVoiceSessionStore((state) => state.driver);
  const destinationKnown = useVoiceSessionStore(
    (state) => state.destinationKnown,
  );
  // Drawn only once the server has said it offers voice: before that answer
  // a Talk would open the microphone to learn there is nothing to talk to.
  if (availability !== "live" || driver === null) return null;
  const live = phase !== "idle";
  // With no bot to talk to (none selected, no main bot known yet) a session
  // would have nowhere to post: Talk stays, disabled, and says so.
  const nowhere = !live && !destinationKnown;
  let label = "Talk with your bots. Costs credits while on.";
  if (live) label = "End the voice session";
  else if (nowhere) label = "No bot to talk to yet.";
  return (
    <TooltipWrapper
      label={label}
      side="bottom"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant={live ? "success-ghost" : "ghost"}
        size={TALK_CONTROL_SIZE[props.form]}
        aria-label={TALK_CONTROL_LABEL}
        aria-pressed={live}
        data-testid="voice-talk-control"
        data-state={phase}
        disabled={phase === "connecting" || phase === "ending" || nowhere}
        onClick={toggleTalk}
        className="shrink-0 self-center [-webkit-app-region:no-drag]"
      >
        <AudioLines aria-hidden="true" />
        {props.form === "label" ? TALK_CONTROL_LABEL : null}
      </Button>
    </TooltipWrapper>
  );
}
