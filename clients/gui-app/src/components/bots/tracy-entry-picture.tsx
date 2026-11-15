import type { ReactNode } from "react";
import { PlainBotAvatar } from "@/components/bots/bot-avatars";
import { cn } from "@/lib/utils";

/**
 * The picture the app's Tracy entry wears, in the strips, the phone drawer
 * and on its tab. The one place that decides it: the same mascot for
 * everyone, whichever bot the entry opens.
 */
export function TracyEntryPicture(): ReactNode {
  return <PlainBotAvatar size="xs" />;
}

/**
 * The entry's picture as a tab's icon, at the mascot's smallest whole-pixel
 * size whatever the slot asks for.
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
