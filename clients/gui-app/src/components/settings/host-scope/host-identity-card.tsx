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
  /**
   * What to call this host, decided by the caller.
   *
   * The Overview passes `host.identity.get`'s `effectiveName` once the host has
   * answered for itself, falling back to `host.name` (registry `displayName`,
   * then directory label) until then and for a host it cannot reach. Both are
   * the same string on a healthy fleet — the registry `displayName` follows the
   * host's `effectiveName` over the heartbeat — so the hand-off is a settle,
   * not a blink: there is never an empty or skeleton state between them, and on
   * the ordinary path the value does not change at all. Right after a rename,
   * or during the rollout window, the RPC answer is simply the fresher of two
   * agreeing sources.
   */
  readonly displayName: string;
  /**
   * What this host says it is RUNNING, decided by the caller on the same
   * two-layer rule as `displayName`: `host.status`'s `hostVersion` for a
   * reachable host, the registry/directory copy when there is no route.
   *
   * Supplied rather than read off `host.version` because those two are not the
   * same fact. The scope row carries the version as of the last cloud check-in;
   * the process's own answer is current. Reading the row here while the rest of
   * the card read the RPC printed BOTH on one card — a provenance line saying
   * v1.4.2 above an endpoint line saying v1.5.0 — which is worse than either
   * number alone, because it makes the card look broken rather than stale.
   */
  readonly version: string | null;
  /**
   * The rename affordance, rendered inline against the name itself.
   *
   * A pencil beside the thing it edits, rather than a third word in the verb
   * bar: renaming is the only action here whose object is the name, and a
   * labelled button sitting beside Restart and Run doctor read as its peer —
   * three equally-weighted maintenance verbs, one of which was cosmetic.
   */
  readonly nameAction: ReactNode;
  /**
   * How many sessions the HOST says are open (`host.status`), or `null` when it
   * has not answered — which is not the same as zero and must not render as it.
   */
  readonly sessionCount: number | null;
  /**
   * The card's verb bar (Restart / Run doctor / Use in this window), or `null`
   * for a surface with nothing to offer. Rendered as a footer strip under the
   * identity rather than opposite it: the header carries a name, a pencil, a
   * status line and up to two tags, and a right-aligned cluster competing for
   * that same row wrapped into a ragged two-column block at every settings
   * width below full screen.
   */
  readonly actions: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const { host } = props;
  const platform = formatPlatform(host.platform);
  const arch = formatArchitecture(host.platform);
  const version = formatHostVersion(props.version);
  // One line of provenance, in words a person reads rather than the build
  // target string the registry happens to store. This is the page's ONLY
  // version, on purpose.
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
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
          <HostGlyph host={host} className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="min-w-0 truncate font-semibold text-foreground text-title-sm">
              {props.displayName}
            </h2>
            {props.nameAction}
            {host.isLocalMachine ? (
              <HostTag label="This computer" tone={undefined} />
            ) : null}
            {/* The "Active for this window" ROW is gone — this tag is what
                replaced it. A full-width bar with its own background said one
                boolean about the window, permanently, on the page about the
                host; the fact belongs beside the name, and the consequence it
                used to spell out now rides the button that changes it. */}
            {host.isActive ? <HostTag label="Active" tone="accent" /> : null}
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
            {host.health.detail === null ? null : (
              <span className="min-w-0 truncate text-ui-sm text-muted-foreground">
                {host.health.detail}
              </span>
            )}
            {facts.length === 0 ? null : (
              // Folded up from its own line. The card gained a footer verb bar,
              // and three stacked lines of identity above it pushed Host ID and
              // everything below off a short settings pane; the separator is
              // what keeps a merged line from reading as one run-on phrase.
              <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
                <span aria-hidden className="mr-2 text-muted-foreground/40">
                  ·
                </span>
                {facts.join(" · ")}
              </span>
            )}
            <ActiveSessionsChip count={props.sessionCount} />
          </div>
        </div>
      </div>
      {props.actions === null ? null : (
        <div
          className="flex flex-wrap items-center gap-2 border-t border-border/40 bg-muted/10 px-5 py-3"
          data-testid="host-identity-actions"
        >
          {props.actions}
        </div>
      )}
      {props.children}
    </section>
  );
}

/**
 * Open sessions, as a state rather than a clause.
 *
 * This is what is left of the `via relay.dev.traycer.ai · 1 active session`
 * meta row. The route half is deliberately gone — a relay origin is not
 * something anyone acts on from this page, and printing it made a monospace
 * band out of the one fact that IS actionable: whether work is running on this
 * host right now, which decides whether Restart is safe to press.
 *
 * `null` renders nothing. A host that has not answered `host.status` has not
 * told us it is idle, and "No sessions" is a claim.
 */
function ActiveSessionsChip(props: {
  readonly count: number | null;
}): ReactNode {
  const { count } = props;
  if (count === null) return null;
  const live = count > 0;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-ui-xs font-medium",
        live
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
          : "border-border/60 bg-muted/40 text-muted-foreground",
      )}
      data-testid="host-active-sessions"
      data-count={count}
    >
      <HostPresenceDot
        tone={live ? "live" : "idle"}
        animate={live}
        className={undefined}
      />
      {live
        ? `${count} active session${count === 1 ? "" : "s"}`
        : "No active sessions"}
    </span>
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
 *
 * The Overview no longer renders this: a full-width row asserting one boolean
 * about the WINDOW, on the page about a HOST, cost more vertical space than the
 * fact was worth. There the binding is an `Active` tag beside the name and a
 * verb in the card's action bar. This survives for the RECOVERY console, whose
 * subject is a local host with no process to ask — it has no such action bar,
 * and its own summary card owns the identity line.
 */
function ThisWindowCard(props: {
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
