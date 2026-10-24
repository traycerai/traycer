import type { ReactNode } from "react";
import { Bot } from "lucide-react";

/**
 * The host answered, and the answer is that it predates bots (no `bot.list`
 * in its handshake). The same notice anatomy as Settings ▸ Usage's. Shown by
 * the Home bots band and by a bot tab whose host lost the capability since
 * the tab was created (a restored tab, a downgraded host): the one surface
 * either can offer is the update, so neither draws a control that would call
 * a `bot.*` method the host does not have.
 */
export function BotsUnavailableNotice(props: {
  readonly testId: string;
}): ReactNode {
  return (
    <div
      role="status"
      data-testid={props.testId}
      className="mx-3 flex flex-col items-start gap-2 rounded-lg border border-border/60 bg-card/40 px-5 py-6"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-foreground/6 text-muted-foreground">
        <Bot className="size-4.5" aria-hidden="true" />
      </span>
      <div className="max-w-[60ch] space-y-1">
        <p className="font-medium text-ui-sm text-foreground">
          Bots aren&apos;t available on this host yet
        </p>
        <p className="text-ui-sm text-muted-foreground">
          This host predates bots. Update it to create and run them from here.
        </p>
      </div>
    </div>
  );
}
