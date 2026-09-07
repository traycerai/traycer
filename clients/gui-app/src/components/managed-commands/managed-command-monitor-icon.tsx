import { CirclePlay, Radar } from "lucide-react";
import { cn } from "@/lib/utils";

/** The queued-delivery chip is the exception: its label is the constant "Shell output", so the glyph is the
 * only carrier and must speak, or a screen-reader user cannot tell a watcher's digest from a dead shell's. */
export function ManagedCommandMonitorIcon(props: {
  readonly monitoring: boolean;
  readonly decorative: boolean;
  readonly className: string | undefined;
}) {
  const Glyph = props.monitoring ? Radar : CirclePlay;
  const stateLabel = props.monitoring ? "Monitoring" : "Not monitoring";
  return (
    <Glyph
      role={props.decorative ? undefined : "img"}
      aria-hidden={props.decorative ? true : undefined}
      aria-label={props.decorative ? undefined : stateLabel}
      data-monitor-icon={props.monitoring ? "on" : "off"}
      className={cn(
        "size-3 shrink-0 text-muted-foreground/70",
        props.className,
      )}
    />
  );
}
