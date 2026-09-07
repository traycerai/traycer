import type { ReactNode } from "react";
import { Cloud, Laptop, MonitorSmartphone, Server } from "lucide-react";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { PingRing } from "@/components/ui/ping-ring";
import { cn } from "@/lib/utils";

const LIVE_RING_PEAK_OPACITY = 0.6;

/** A host's glyph. */
export function HostGlyph(props: {
  readonly host: HostScopeOption;
  readonly className: string | undefined;
}): ReactNode {
  // Selecting the type at render time makes it a component created during render, which remounts the subtree
  // whenever the host changes kind (and trips `react-hooks/static-components`).
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

/** A pinging dot with nothing behind it is the exact lie the presence model was built to refuse, so the ping is
 * gated on the evidence flag rather than on the tone. */
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
        <PingRing toneClass={toneClass} peakOpacity={LIVE_RING_PEAK_OPACITY} />
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
