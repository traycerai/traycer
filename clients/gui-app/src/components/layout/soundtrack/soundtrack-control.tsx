import { useEffect, type ReactNode } from "react";
import { Music } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { isActionAvailable } from "@/lib/keybindings/actions";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { soundtrackOffered } from "@/lib/soundtrack/manifest";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";

const SOUNDTRACK_CONTROL_LABEL = "Soundtrack";

/**
 * The toggle, shared by the control and the palette. It reads the person's wish
 * rather than the session, because the two differ until the first gesture after
 * a launch, and that gesture may be this one: the warm-up has just opened the
 * session and this press is asking for it off. Off reaches the session through
 * the settings store, the way another window's does.
 */
function toggleSoundtrack(): void {
  const { soundtrackEnabled, setSoundtrackEnabled } =
    useSettingsStore.getState();
  setSoundtrackEnabled(!soundtrackEnabled);
  if (!soundtrackEnabled) useSoundtrackStore.getState().enable();
}

/** Registers the toggle with the keybinding registry, mounted once. */
export function SoundtrackShortcutBridge(): ReactNode {
  useEffect(() => {
    if (!isActionAvailable("soundtrack.toggle")) return undefined;
    return registerDynamicActionHandler("soundtrack.toggle", toggleSoundtrack);
  }, []);
  return null;
}

/**
 * The soundtrack's toggle, beside Talk in the window's top row. Not drawn in a
 * build with nothing to play.
 */
export function SoundtrackControl(): ReactNode {
  const on = useSettingsStore((state) => state.soundtrackEnabled);
  if (!soundtrackOffered()) return null;
  return (
    <TooltipWrapper
      label={on ? "Stop the soundtrack" : "Play the soundtrack"}
      side="bottom"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant={on ? "success-ghost" : "ghost"}
        size="xs"
        aria-label={SOUNDTRACK_CONTROL_LABEL}
        aria-pressed={on}
        data-testid="soundtrack-control"
        onClick={toggleSoundtrack}
        className="shrink-0 self-center [-webkit-app-region:no-drag]"
      >
        <Music aria-hidden="true" />
        {SOUNDTRACK_CONTROL_LABEL}
      </Button>
    </TooltipWrapper>
  );
}
