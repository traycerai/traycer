import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { modLabel } from "@/lib/keybindings/platform";

/** Visible Cmd/Ctrl+Enter hint shared by primary action buttons. */
export function PrimaryActionShortcutHint() {
  return (
    <KbdGroup aria-hidden>
      <Kbd className="border-current bg-transparent text-current">
        {modLabel()}
      </Kbd>
      <Kbd className="border-current bg-transparent text-current">↵</Kbd>
    </KbdGroup>
  );
}
