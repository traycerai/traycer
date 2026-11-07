import type { ReactNode } from "react";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";
import { describeHostBusy } from "@/components/host/host-restart-copy";
import {
  HostGlyph,
  HostPresenceDot,
} from "@/components/settings/host-scope/host-glyph";
import {
  hostOptionKindLabel,
  sandboxStateWord,
  sandboxWordYieldsToHealth,
} from "@/components/settings/host-scope/host-option-model";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

/** One host header, followed by its notices, settings source and sections. */
export function HostIdentityCard(props: {
  readonly host: HostScopeOption;
  readonly displayName: string;
  readonly nameAction: ReactNode;
  readonly nameInput: ReactNode | null;
  readonly busy: boolean;
  readonly busySessionCount: number | null;
  readonly busyBreakdown: HostBusyBreakdown | null;
  readonly actions: ReactNode;
  readonly healthAction: ReactNode;
  readonly lifecycleLine: ReactNode;
  readonly costLine?: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const { host } = props;
  const busyCopy = describeHostBusy({
    breakdown: props.busyBreakdown,
    busySessionCount: props.busySessionCount,
    busy: props.busy,
  });
  return (
    <section
      className="flex min-h-0 flex-col rounded-xl border border-border/60 bg-card/40"
      data-testid="host-identity-card"
      aria-label={`${props.displayName} overview`}
    >
      <div className="flex min-w-0 shrink-0 items-start gap-3 px-5 py-4">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/6 text-muted-foreground">
          <HostGlyph host={host} className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:justify-between">
            <div
              className="flex min-w-0 w-full flex-1 items-start gap-x-2 gap-y-1 sm:w-auto sm:flex-wrap sm:items-center"
              data-testid="host-identity-name-row"
            >
              {props.nameInput === null ? (
                <>
                  <h2 className="min-w-0 wrap-anywhere font-semibold text-foreground text-title-sm">
                    {props.displayName}
                  </h2>
                  {props.nameAction}
                </>
              ) : (
                props.nameInput
              )}
            </div>
            {props.actions}
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-ui-xs text-muted-foreground">
            {host.sandbox === null || sandboxWordYieldsToHealth(host) ? (
              <HostIdentityHealth host={host} />
            ) : (
              <span data-testid="host-identity-sandbox-state">
                {sandboxStateWord(host.sandbox)}
              </span>
            )}
            <span aria-hidden>·</span>
            <span>{hostOptionKindLabel(host)}</span>
            {busyCopy.label === null ? null : (
              <>
                <span aria-hidden>·</span>
                <TooltipWrapper
                  label={busyCopy.label}
                  side="top"
                  sideOffset={undefined}
                  align={undefined}
                >
                  <button
                    type="button"
                    className="cursor-default rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="host-active-sessions"
                    data-count={props.busySessionCount ?? ""}
                    data-live={props.busy ? "true" : "false"}
                  >
                    {busyCopy.kind === "idle" ? "Idle" : "Busy"}
                  </button>
                </TooltipWrapper>
              </>
            )}
            {props.costLine}
          </div>
        </div>
      </div>
      {host.health.state !== "update-required" &&
      (host.health.tone === "live" ||
        (host.health.detail ?? "").length === 0) ? null : (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-3 text-ui-xs text-muted-foreground">
          <span className="min-w-0 wrap-anywhere">{host.health.detail}</span>
          {props.healthAction}
        </div>
      )}
      {props.lifecycleLine === null ? null : (
        <div className="shrink-0 px-5 pb-3">{props.lifecycleLine}</div>
      )}
      {props.children}
    </section>
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

function HostIdentityHealth(props: {
  readonly host: HostScopeOption;
}): ReactNode {
  const { host } = props;
  return (
    <span className="flex items-center gap-1.5 text-ui-sm">
      <HostPresenceDot
        tone={host.health.tone}
        animate={host.health.live}
        className={undefined}
      />
      <span
        className={cn(
          "font-medium",
          host.health.tone === "live" && "text-success-foreground",
          host.health.tone === "warn" && "text-warning-foreground",
          host.health.tone === "idle" && "text-muted-foreground",
        )}
        data-testid="host-identity-health"
      >
        {host.health.label}
      </span>
    </span>
  );
}
