import type { ReactNode } from "react";
import { BotMascotFrame } from "@/components/bots/bot-mascot-frame";
import { DEFAULT_MASCOT, MASCOT_AT_REST } from "@/lib/bots/mascot-mark";
import { cn } from "@/lib/utils";

/**
 * The picture the app's Tracy entry wears, in the strips, the phone drawer
 * and on its tab. The one place that decides it: the default mascot at 16 px,
 * whichever bot the entry opens. It reads nothing of any bot, so the tab kind
 * can name it without reaching back into the tab registry.
 */
export function TracyEntryPicture(): ReactNode {
  return (
    <BotMascotFrame
      mascot={DEFAULT_MASCOT}
      pose={MASCOT_AT_REST}
      size="xs"
      testId="bot-avatar"
    />
  );
}

/**
 * The entry's picture as a tab's icon. `className` styles the wrapper only:
 * the picture stays 16 px, the mascot's smallest whole-pixel size, in any
 * slot.
 */
export function TracyTabIcon(props: {
  readonly className: string | undefined;
}): ReactNode {
  return (
    <span className={cn("inline-flex shrink-0", props.className)}>
      <TracyEntryPicture />
    </span>
  );
}
