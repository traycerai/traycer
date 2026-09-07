import type { ReactNode } from "react";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";
import { describeHostBusy } from "@/components/host/host-restart-copy";
import {
  HostGlyph,
  HostPresenceDot,
} from "@/components/settings/host-scope/host-glyph";
import {
  formatArchitecture,
  formatHostVersion,
  formatPlatform,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import { cn } from "@/lib/utils";

/** A host is now the subject of exactly one page - this one - and appears elsewhere only as a row in the picker
 * that navigates to it. */
export function HostIdentityCard(props: {
  readonly host: HostScopeOption;
  /** The Overview passes `host.identity.get`'s `effectiveName` once the host has answered for itself, falling
   * back to `host.name` (registry `displayName`. */
  readonly displayName: string;
  /** Supplied rather than read off `host.version` because those two are not the same fact. */
  readonly version: string | null;
  /** A pencil beside the thing it edits, rather than a third word in the verb bar: renaming is the only action
   * here whose object is the name, and a labelled button sitting beside Restart and Run doctor read as its peer. */
  readonly nameAction: ReactNode;
  /** Non-null replaces the heading rather than rendering under it. */
  readonly nameInput: ReactNode | null;
  /** `busySessionCount`/`busyBreakdown` of `null` mean the host did not say - which is not the same as zero and
   * must not render as it. Live tone follows `busy`, never a viewer/tile count. */
  readonly busy: boolean;
  readonly busySessionCount: number | null;
  readonly busyBreakdown: HostBusyBreakdown | null;
  /** That is why this must stay narrow: put worded buttons back in here and the wrap returns. */
  readonly actions: ReactNode;
  /** A slot rather than a derivation, so this component stays presentational. */
  readonly healthAction: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const { host } = props;
  const platform = formatPlatform(host.platform);
  const arch = formatArchitecture(host.platform);
  const version = formatHostVersion(props.version);
  // One line of provenance, in words a person reads rather than the build target string the registry happens to
  // store. This is the page's only version, on purpose.
  const facts = [platform, arch, version].filter(
    (part): part is string => part !== null && part.length > 0,
  );

  return (
    <section
      className="overflow-hidden rounded-xl border border-border/60 bg-card/40"
      data-testid="host-identity-card"
      aria-label={`${props.displayName} overview`}
    >
      <div className="flex min-w-0 items-start gap-3 px-5 py-4">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/6 text-muted-foreground">
          <HostGlyph host={host} className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
              {props.nameInput === null ? (
                <>
                  <h2 className="min-w-0 truncate font-semibold text-foreground text-title-sm">
                    {props.displayName}
                  </h2>
                  {props.nameAction}
                </>
              ) : (
                props.nameInput
              )}
              {/* A remote host now gets a tag too - the absence of one was never a deliberate signal, just the local-only
                 branch showing. */}
              <HostTag
                label={host.isLocalMachine ? "Local" : "Remote"}
                tone={undefined}
              />
            </div>
            {/* Both are now one slot inside `actions`, so the state and the control that reaches it occupy the same place. */}
            {props.actions}
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="flex items-center gap-1.5 text-ui-sm">
              <HostPresenceDot
                tone={host.health.tone}
                animate={host.health.live}
                className={undefined}
              />
              <span
                className={cn(
                  "font-medium",
                  host.health.tone === "live" && "text-emerald-500",
                  host.health.tone === "warn" && "text-amber-500",
                  host.health.tone === "idle" && "text-muted-foreground",
                )}
                data-testid="host-identity-health"
              >
                {host.health.label}
              </span>
            </span>
            {/* Suppressing those left them rendered nowhere, since the picker deliberately shows only a dot. */}
            {host.health.tone === "live" ||
            (host.health.detail ?? "").length === 0 ? null : (
              <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
                <span aria-hidden className="mr-2 text-muted-foreground/40">
                  ·
                </span>
                {host.health.detail}
              </span>
            )}
            {props.healthAction}
            {facts.length === 0 ? null : (
              // Folded up from its own line.
              <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
                <span aria-hidden className="mr-2 text-muted-foreground/40">
                  ·
                </span>
                {facts.join(" · ")}
              </span>
            )}
            <HostBusyChip
              busy={props.busy}
              busySessionCount={props.busySessionCount}
              busyBreakdown={props.busyBreakdown}
            />
          </div>
        </div>
      </div>
      {props.children}
    </section>
  );
}

/** Live (emerald, pulsing) only when `busy` - an idle shell must not light the chip. */
function HostBusyChip(props: {
  readonly busy: boolean;
  readonly busySessionCount: number | null;
  readonly busyBreakdown: HostBusyBreakdown | null;
}): ReactNode {
  const copy = describeHostBusy({
    breakdown: props.busyBreakdown,
    busySessionCount: props.busySessionCount,
    busy: props.busy,
  });
  if (copy.label === null) return null;
  const live = props.busy;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-ui-xs font-medium",
        live
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
          : "border-border/60 bg-foreground/5 text-muted-foreground",
      )}
      data-testid="host-active-sessions"
      data-count={props.busySessionCount ?? ""}
      data-live={live ? "true" : "false"}
    >
      <HostPresenceDot
        tone={live ? "live" : "idle"}
        animate={live}
        className={undefined}
      />
      {copy.label}
    </span>
  );
}

export function HostTag(props: {
  readonly label: string;
  readonly tone: "muted" | "accent" | undefined;
}): ReactNode {
  const accent = props.tone === "accent";
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm px-1 py-px text-[0.625rem] font-medium tracking-wide uppercase",
        accent
          ? "bg-primary/15 text-primary"
          : "bg-foreground/6 text-muted-foreground",
      )}
    >
      {props.label}
    </span>
  );
}
