import { CirclePlay, Radar } from "lucide-react";
import type { ManagedCommandKind } from "@traycer/protocol/host/managed-command/unary-schemas";
import { cn } from "@/lib/utils";

/**
 * The one glyph per kind, used by every managed-command surface so a Monitor
 * looks like a Monitor wherever it appears.
 *
 * `Radar` for a monitor - something sweeping and still watching - and
 * `CirclePlay` for a shell - one run, started and finished. Deliberately NOT
 * lucide's `Monitor`, which is a display and reads as "screen", and
 * deliberately not a terminal glyph for shells, which would collide with the
 * Terminals surface next door.
 *
 * The icon SUPPLEMENTS kind-explicit text and never replaces it (`UI.md` §3):
 * it is `aria-hidden` because the row always says "Monitor" or "Shell" in
 * words, and it stays neutral-toned because colour on this surface means
 * status and nothing else.
 */
export function ManagedCommandKindIcon(props: {
  readonly kind: ManagedCommandKind;
  readonly className: string | undefined;
}) {
  const Glyph = props.kind === "monitor" ? Radar : CirclePlay;
  return (
    <Glyph
      aria-hidden
      data-kind-icon={props.kind}
      className={cn(
        "size-3 shrink-0 text-muted-foreground/70",
        props.className,
      )}
    />
  );
}
