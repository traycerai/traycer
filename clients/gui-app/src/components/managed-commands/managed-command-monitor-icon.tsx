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
 * Whether it SPEAKS is the caller's call, because it depends on the copy next
 * to it. Every title now names the state ("Monitor · deploy watcher" vs
 * "Shell · db migration"), so on a row or a window header the glyph is
 * `decorative` - announcing "Monitoring" there would read the same fact out
 * twice. The queued-delivery chip is the exception: its label is the constant
 * "Shell output", so the glyph is the only carrier and must speak, or a
 * screen-reader user cannot tell a watcher's digest from a dead shell's.
 *
 * It stays neutral-toned because colour on this surface means status and
 * nothing else.
 */
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
