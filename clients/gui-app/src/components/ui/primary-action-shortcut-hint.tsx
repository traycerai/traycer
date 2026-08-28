import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import { modLabel } from "@/lib/keybindings/platform";

/**
 * Visible Cmd/Ctrl+Enter hint shared by primary action buttons. Renders
 * nothing where shortcut hints are suppressed, so a call site can drop it
 * beside a label unconditionally - the label is what carries the button.
 */
export function PrimaryActionShortcutHint() {
  return (
    <ShortcutHint>
      <KbdGroup aria-hidden>
        <Kbd className="border-current bg-transparent text-current">
          {modLabel()}
        </Kbd>
        <Kbd className="border-current bg-transparent text-current">↵</Kbd>
      </KbdGroup>
    </ShortcutHint>
  );
}
