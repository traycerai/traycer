import { useContext, type ReactNode } from "react";
import { BotMentionsContext } from "@/components/bots/bot-mentions-context";
import { cn } from "@/lib/utils";

/**
 * A mention in a message: the member's name as a chip, highlighted when it
 * is the viewer; the token as written where it names no member.
 */
export function BotMentionChip(props: {
  readonly userId: string;
  readonly children: ReactNode;
}): ReactNode {
  const resolve = useContext(BotMentionsContext);
  const mentioned = resolve === null ? null : resolve(props.userId);
  if (mentioned === null) return <>{props.children}</>;
  return (
    <span
      data-testid="bot-mention"
      data-self={mentioned.self ? "true" : "false"}
      className={cn(
        "rounded-sm px-0.5 font-medium",
        mentioned.self
          ? "bg-warning/20 text-warning-foreground"
          : "bg-info/10 text-info-foreground",
      )}
    >
      {`@${mentioned.name}`}
    </span>
  );
}
