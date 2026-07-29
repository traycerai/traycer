import {
  managedCommandStatusLabel,
  managedCommandStatusTone,
} from "@/lib/managed-commands/managed-command-copy";
import type { ManagedCommandStatus } from "@traycer/protocol/host/managed-command/unary-schemas";
import { cn } from "@/lib/utils";

const TONE_CLASS = {
  running: "bg-success",
  failed: "bg-destructive",
  idle: "bg-muted-foreground/50",
} as const;

/**
 * The passive status signal (`UI.md` §7): a dot that changes and nothing that
 * toasts, badges or pings. Its accessible name carries the same text the row
 * shows, so a screen reader is not left with a colour.
 */
export function ManagedCommandStatusDot(props: {
  readonly status: ManagedCommandStatus;
  readonly className: string | undefined;
}) {
  const label = managedCommandStatusLabel(props.status);
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        TONE_CLASS[managedCommandStatusTone(props.status)],
        props.className,
      )}
    />
  );
}
