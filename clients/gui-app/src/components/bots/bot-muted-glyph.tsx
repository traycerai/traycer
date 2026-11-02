import type { ReactNode } from "react";
import { BellOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The mark of a channel the person set to Nothing (decision 138): muted, so
 * it never rings or goes bold, though a mention of them still counts.
 */
export function BotMutedGlyph(props: {
  readonly className: string | undefined;
  readonly testId: string;
}): ReactNode {
  return (
    <BellOff
      className={cn("size-3 shrink-0 text-muted-foreground", props.className)}
      aria-label="Muted"
      role="img"
      data-testid={props.testId}
    />
  );
}
