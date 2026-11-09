import type { ReactNode } from "react";
import { HOST_FROZEN_WORD } from "@traycer/protocol/host/host-status";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";
import {
  describeHostBusy,
  type HostBusyCopy,
} from "@/components/host/host-restart-copy";
import {
  HostGlyph,
  HostPresenceDot,
} from "@/components/settings/host-scope/host-glyph";
import {
  hostOptionKindLabel,
  sandboxStateWord,
  sandboxWordYieldsToHealth,
} from "@/components/settings/host-scope/host-option-model";
import {
  formatArchitecture,
  formatHostVersion,
  formatPlatform,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

/** One host header, followed by its notices, settings source and sections. */
export function HostIdentityCard(props: {
  readonly host: HostScopeOption;
  readonly displayName: string;
  /**
   * What this host says it is running: the process answer when it has one,
   * otherwise the account's last report. The caller passes
   * `view.hostVersion ?? host.version`.
   */
  readonly version: string | null;
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
              <HostTag label={hostOptionKindLabel(host)} tone={undefined} />
            </div>
            {props.actions}
          </div>
          <HostIdentityFactLine
            host={host}
            version={props.version}
            busy={props.busy}
            busySessionCount={props.busySessionCount}
            busyBreakdown={props.busyBreakdown}
            healthAction={props.healthAction}
            lifecycleLine={props.lifecycleLine}
            costLine={props.costLine ?? null}
          />
        </div>
      </div>
      {props.children}
    </section>
  );
}

function HostIdentityFactLine(props: {
  readonly host: HostScopeOption;
  readonly version: string | null;
  readonly busy: boolean;
  readonly busySessionCount: number | null;
  readonly busyBreakdown: HostBusyBreakdown | null;
  readonly healthAction: ReactNode;
  readonly lifecycleLine: ReactNode;
  readonly costLine: ReactNode;
}): ReactNode {
  const { host } = props;
  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-ui-xs text-muted-foreground">
      <HostIdentityState host={host} />
      {host.sandbox?.frozen === true ? (
        <span className="text-warning-foreground">{HOST_FROZEN_WORD}</span>
      ) : null}
      <HostProvenanceFacts
        platform={formatPlatform(host.platform)}
        architecture={formatArchitecture(host.platform)}
        version={formatHostVersion(props.version)}
      />
      <HostWorkFact
        busy={props.busy}
        busySessionCount={props.busySessionCount}
        busyBreakdown={props.busyBreakdown}
      />
      <HostHealthDetail host={host} action={props.healthAction} />
      {props.lifecycleLine}
      {props.costLine}
    </div>
  );
}

function HostIdentityState(props: {
  readonly host: HostScopeOption;
}): ReactNode {
  const { host } = props;
  if (host.sandbox === null || sandboxWordYieldsToHealth(host)) {
    return <HostIdentityHealth host={host} />;
  }
  return (
    <span data-testid="host-identity-sandbox-state">
      {sandboxStateWord(host.sandbox)}
    </span>
  );
}

function HostProvenanceFacts(props: {
  readonly platform: string | null;
  readonly architecture: string | null;
  readonly version: string | null;
}): ReactNode {
  const parts = [props.platform, props.architecture, props.version].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  if (parts.length === 0) return null;
  return (
    <>
      <span aria-hidden>·</span>
      <span>{parts.join(" · ")}</span>
    </>
  );
}

/** The breakdown without the trailing "working"; the tooltip keeps the full sentence. */
function hostWorkVisibleLabel(copy: HostBusyCopy): string | null {
  if (copy.label === null) return null;
  if (copy.kind === "named" && copy.label.endsWith(" working")) {
    return copy.label.slice(0, -" working".length);
  }
  return copy.label;
}

function HostWorkFact(props: {
  readonly busy: boolean;
  readonly busySessionCount: number | null;
  readonly busyBreakdown: HostBusyBreakdown | null;
}): ReactNode {
  const copy = describeHostBusy({
    breakdown: props.busyBreakdown,
    busySessionCount: props.busySessionCount,
    busy: props.busy,
  });
  const visible = hostWorkVisibleLabel(copy);
  if (visible === null || copy.label === null) return null;
  return (
    <>
      <span aria-hidden>·</span>
      <TooltipWrapper
        label={copy.label}
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
          {visible}
        </button>
      </TooltipWrapper>
    </>
  );
}

function hostHealthDetailShown(host: HostScopeOption): boolean {
  if (host.health.state === "update-required") return true;
  if (host.health.tone === "live") return false;
  return (host.health.detail ?? "").length > 0;
}

function HostHealthDetail(props: {
  readonly host: HostScopeOption;
  readonly action: ReactNode;
}): ReactNode {
  if (!hostHealthDetailShown(props.host)) return null;
  return (
    <>
      <span aria-hidden>·</span>
      <span className="min-w-0 wrap-anywhere">{props.host.health.detail}</span>
      {props.action}
    </>
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
