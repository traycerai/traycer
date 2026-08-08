import type { ReactNode } from "react";
import { Cloud, Laptop, MonitorSmartphone, Server } from "lucide-react";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { cn } from "@/lib/utils";

/**
 * A host's glyph.
 *
 * The old list drew a CLOUD on every row — including the laptop the app was
 * running on. That single wrong icon is most of why the local host read as
 * a different species from itself in the section below. The glyph now answers
 * "what kind of host is this?": the one on this computer, another host you own,
 * or something reached over a relay.
 */
export function HostGlyph(props: {
  readonly host: HostScopeOption;
  readonly className: string | undefined;
}): ReactNode {
  // Each branch returns a fixed element rather than picking a component and
  // rendering it as `<Icon />`. Selecting the TYPE at render time makes it a
  // component created during render, which remounts the subtree whenever the
  // host changes kind (and trips `react-hooks/static-components`).
  const className = cn("shrink-0", props.className);
  if (props.host.isLocalMachine) {
    return <Laptop className={className} aria-hidden />;
  }
  if (props.host.entry?.kind === "remote") {
    return <Cloud className={className} aria-hidden />;
  }
  if (props.host.entry?.kind === "mock") {
    return <Server className={className} aria-hidden />;
  }
  return <MonitorSmartphone className={className} aria-hidden />;
}

const DOT_TONE = {
  live: "bg-emerald-500",
  warn: "bg-amber-500",
  idle: "bg-muted-foreground/45",
} as const;

/**
 * The presence dot.
 *
 * `live` is the ONLY tone that animates, and it animates only when real live
 * evidence backs it (`health.live`) — a fresh lease or an open session. A
 * pinging dot with nothing behind it is the exact lie the presence model was
 * built to refuse, so the ping is gated on the evidence flag rather than on
 * the tone.
 */
export function HostPresenceDot(props: {
  readonly tone: "live" | "warn" | "idle";
  readonly animate: boolean;
  readonly className: string | undefined;
}): ReactNode {
  const toneClass = DOT_TONE[props.tone];
  return (
    <span
      className={cn("relative inline-flex size-1.5 shrink-0", props.className)}
      aria-hidden
    >
      {props.animate ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            toneClass,
          )}
        />
      ) : null}
      <span
        className={cn(
          "relative inline-flex h-full w-full rounded-full",
          toneClass,
        )}
      />
    </span>
  );
}
