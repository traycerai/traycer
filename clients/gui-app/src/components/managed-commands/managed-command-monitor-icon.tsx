import { CirclePlay, Radar } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one glyph per shell, used by every managed-command surface so a shell
 * that is watching for you looks the same wherever it appears.
 *
 * `Radar` while the shell monitors - something sweeping, telling the agent what
 * it sees - and `CirclePlay` while it does not - a run nobody is being told
 * about. Deliberately NOT lucide's `Monitor`, which is a display and reads as
 * "screen", and deliberately not a terminal glyph, which would collide with the
 * Terminals surface next door.
 *
 * The flag is live-tunable, so the glyph swaps under a row that stays put. That
 * is the point: the swap is what depicts "this stopped being a watcher".
 *
 * Under the old model the icon supplemented kind-explicit text and hid from
 * assistive tech. Post-unification every label is the constant "Shell", so
 * this glyph is the ONLY carrier of the monitor state - it must speak, or a
 * screen-reader user cannot tell a watching shell from a silent one anywhere
 * in the product. It stays neutral-toned because colour on this surface means
 * status and nothing else.
 */
export function ManagedCommandMonitorIcon(props: {
  readonly monitoring: boolean;
  readonly className: string | undefined;
}) {
  const Glyph = props.monitoring ? Radar : CirclePlay;
  return (
    <Glyph
      role="img"
      aria-label={props.monitoring ? "Monitoring" : "Not monitoring"}
      data-monitor-icon={props.monitoring ? "on" : "off"}
      className={cn(
        "size-3 shrink-0 text-muted-foreground/70",
        props.className,
      )}
    />
  );
}
