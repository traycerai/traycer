import { ExternalLink } from "lucide-react";
import { ManagedCommandActionButton } from "@/components/managed-commands/managed-command-action-buttons";

/**
 * "Take me to this shell's output window" as an icon, wherever a surface offers
 * it beside a shell rather than being the door itself.
 *
 * An icon rather than the words it replaced: it sits in a header action slot
 * next to lifecycle glyphs, where a text button was the one control shouting,
 * and "open this in a tab" is the same act the app spells with this glyph
 * everywhere else.
 */
export function ManagedCommandOpenInTabButton(props: {
  readonly testId: string;
  readonly onOpen: () => void;
}) {
  return (
    <ManagedCommandActionButton
      label="Open in tab"
      ariaLabel="Open in tab"
      icon={<ExternalLink aria-hidden className="size-3.5" />}
      isPending={false}
      testId={props.testId}
      className={undefined}
      onClick={props.onOpen}
    />
  );
}
