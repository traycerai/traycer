import type { ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
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
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { cn } from "@/lib/utils";

/**
 * The scoped host's identity — the page's subject, stated once.
 *
 * This replaces a pair of surfaces that described the SAME host twice and
 * disagreed while doing it: a "My Hosts" row (cloud icon, platform triple,
 * build id, a run of pills, an unlabelled switch) and a separate "This
 * machine" card ("Running", a monospace `ws://…· pid` line, its own update
 * mechanism). A host is now the subject of exactly one page — this one — and
 * appears elsewhere only as a row in the picker that navigates to it.
 */
export function HostIdentityCard(props: {
  readonly host: HostScopeOption;
  readonly onRename: (() => void) | null;
  readonly renameDisabled: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const { host } = props;
  const platform = formatPlatform(host.platform);
  const arch = formatArchitecture(host.platform);
  const version = formatHostVersion(host.version);
  // One line of provenance, in words a person reads rather than the build
  // target string the registry happens to store.
  const facts = [platform, arch, version].filter(
    (part): part is string => part !== null && part.length > 0,
  );

  return (
    <section
      className="overflow-hidden rounded-xl border border-border/60 bg-card/40"
      data-testid="host-identity-card"
      aria-label={`${host.name} overview`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
            <HostGlyph host={host} className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate font-semibold text-foreground text-title-sm">
                {host.name}
              </h2>
              {host.isLocalMachine ? (
                <HostTag label="This computer" tone={undefined} />
              ) : null}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-ui-sm">
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
              {host.health.detail === null ? null : (
                <span className="min-w-0 truncate text-muted-foreground">
                  {host.health.detail}
                </span>
              )}
            </div>
            {facts.length === 0 ? null : (
              <p className="mt-1 truncate text-ui-xs text-muted-foreground">
                {facts.join(" · ")}
              </p>
            )}
          </div>
        </div>
        {props.onRename === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.renameDisabled}
            onClick={props.onRename}
            data-testid="host-identity-rename"
          >
            Rename
          </Button>
        )}
      </div>
      {props.children}
    </section>
  );
}

/**
 * "Which host does this window use?" — answered where the consequence is,
 * and changed only by a verb that states it.
 *
 * The old app had exactly one control for this: a modal radiogroup that looked
 * like the four viewing dropdowns and silently rebound the window's bell, rate
 * limits and default landing target. Making the swap a labelled button whose
 * copy names what moves — and what deliberately does not — is the whole
 * separation between a lens and a binding.
 */
export function ThisWindowCard(props: {
  readonly scope: HostScope;
  readonly host: HostScopeOption;
}): ReactNode {
  const { scope, host } = props;
  if (host.isActive) {
    return (
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/40 bg-primary/5 px-5 py-3"
        data-testid="host-this-window-active"
      >
        <span className="flex items-center gap-2 font-medium text-ui-sm text-primary">
          <Check className="size-4" aria-hidden />
          Active for this window
        </span>
        <span className="min-w-0 text-ui-xs text-muted-foreground">
          Notifications, rate limits and newly started work come from here.
        </span>
      </div>
    );
  }
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 px-5 py-3"
      data-testid="host-this-window-inactive"
    >
      <div className="min-w-0">
        <p className="text-ui-sm text-foreground">
          This window uses{" "}
          <span className="font-medium">
            {scope.activeHost?.name ?? "another host"}
          </span>
          .
        </p>
        <p className="mt-0.5 text-ui-xs text-muted-foreground">
          {/* The asymmetry has to be said out loud. Tabs bind to their host for
              life, so a person who expects "switch" to move their work would
              otherwise watch nothing happen and conclude the button is broken. */}
          Switching changes where new work starts. Tabs you already have open
          stay on the host they started on.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!host.connectable}
        onClick={() => scope.makeActive(host.hostId)}
        data-testid="host-make-active"
      >
        Use this host in this window
      </Button>
    </div>
  );
}

/**
 * `ThisWindowCard` for the host on this computer, whose console is the
 * pre-existing summary card rather than `HostIdentityCard`. Same content, same
 * copy — it just brings its own border because it is not nested in a card.
 */
export function ThisWindowCardStandalone(props: {
  readonly scope: HostScope;
  readonly host: HostScopeOption;
}): ReactNode {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card/40">
      <ThisWindowCard scope={props.scope} host={props.host} />
    </div>
  );
}

/**
 * The host id, copyable, in the one place it is genuinely useful (a support
 * report) rather than leading an identity line as it used to.
 */
export function HostIdRow(props: {
  readonly hostId: string;
  readonly onCopy: (value: string) => void;
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/40 px-5 py-2.5">
      <span className="text-ui-xs text-muted-foreground">Host ID</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-code-xs text-muted-foreground">
          {props.hostId}
        </span>
        <TooltipWrapper
          label="Copy host ID"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-7 p-0"
            onClick={() => props.onCopy(props.hostId)}
            aria-label="Copy host ID"
          >
            <Copy className="size-3.5" />
          </Button>
        </TooltipWrapper>
      </span>
    </div>
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
          : "bg-muted/70 text-muted-foreground",
      )}
    >
      {props.label}
    </span>
  );
}
