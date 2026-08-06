import type { ReactNode } from "react";
import { Cloud, Laptop, MonitorSmartphone, Server } from "lucide-react";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { cn } from "@/lib/utils";

/**
 * A machine's glyph.
 *
 * The old list drew a CLOUD on every row — including the laptop the app was
 * running on. That single wrong icon is most of why the local machine read as
 * a different species from itself in the section below. The glyph now answers
 * "what kind of machine is this?": your own device, another machine you own,
 * or something reached over a relay.
 */
export function HostGlyph(props: {
  readonly host: HostScopeOption;
  readonly className: string | undefined;
}): ReactNode {
  const Icon = glyphFor(props.host);
  return <Icon className={cn("shrink-0", props.className)} aria-hidden />;
}

function glyphFor(host: HostScopeOption): typeof Cloud {
  if (host.isLocalMachine) return Laptop;
  if (host.entry?.kind === "remote") return Cloud;
  if (host.entry?.kind === "mock") return Server;
  return MonitorSmartphone;
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
      className={cn(
        "relative inline-flex size-1.5 shrink-0",
        props.className,
      )}
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
