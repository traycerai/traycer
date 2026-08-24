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
   * The in-place editor, or `null` when not renaming.
   *
   * Non-null REPLACES the heading rather than rendering under it. The editor
   * used to be a band of its own between the header and the host id — opening
   * it pushed the card taller and moved everything below, so the one thing you
   * were looking at jumped as you reached for it. Swapping the name for an
   * input of the same size leaves the card exactly the height it already was,
   * which is what the tab strips have always done (`useInlineRename`).
   */
  readonly nameInput: ReactNode | null;
  /**
   * What the HOST says is working (`host.status@1.2`'s breakdown + total, or
   * the @1.1 count alone). `busySessionCount`/`busyBreakdown` of `null` mean
   * the host did not say — which is not the same as zero and must not render
   * as it. Live tone follows `busy`, never a viewer/tile count.
   */
  readonly busy: boolean;
  readonly busySessionCount: number | null;
  readonly busyBreakdown: HostBusyBreakdown | null;
  /**
   * The card's action cluster, or `null` for a surface with nothing to offer.
   *
   * Opposite the name, NOT a footer strip. An earlier pass tried exactly this
   * and reverted it: three worded buttons competing for the name's row wrapped
   * into a ragged two-column block at every settings width below full screen.
   * The strip that replaced them then cost a full band for three controls.
   *
   * What makes the header work now is width, not placement — the cluster is one
   * control plus a `⋯` trigger, so it fits beside a truncating name instead of
   * fighting it. That is why this must stay narrow: put worded buttons back in
   * here and the wrap returns.
   */
  readonly actions: ReactNode;
  /**
   * The remedy for the health state currently shown, or `null` when the state
   * has none this app can offer.
   *
   * A SLOT rather than a derivation, so this component stays presentational:
   * the only state that carries one today is `update-required`, whose action
   * needs the lease's structured incompatibility and the host-controller
   * mutation lane, and reading either here would put a `useRunnerHost` and a
   * lease subscription below the boundary that every panel suite mocks — the
   * same layering mistake `settingUp` was moved OUT of the row component to
   * fix. The panel owns those facts; this owns where the button sits.
   *
   * It sits beside the health word, not in `actions`, and that is deliberate:
   * `actions` is the card's narrow name-row cluster (one control plus a `⋯`),
   * documented above as something that wraps badly the moment a worded button
   * joins it. A remedy also belongs next to the problem it answers rather than
   * opposite the title.
   */
  readonly healthAction: ReactNode;
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
              {/* One vocabulary for one fact. The picker has always called
                  these Local and Remote; this card said "This computer" for
                  the same host and said nothing at all for the other kind, so
                  the two surfaces described one fleet in two languages. A
                  remote host now gets a tag too — the absence of one was never
                  a deliberate signal, just the local-only branch showing. */}
              <HostTag
                label={host.isLocalMachine ? "Local" : "Remote"}
                tone={undefined}
              />
            </div>
            {/* The window binding used to be an `Active` tag here and a verb in
                the footer, with nothing tying them together. Both are now one
                slot inside `actions`, so the state and the control that reaches
                it occupy the same place. */}
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
            {/* `health.detail` renders for the NON-live states only. Live
                details are the redundant ones — "Running on this computer."
                repeats the `Local` tag, and the relay route line was
                deliberately dropped with the meta row — but an offline or
                unknown host's detail is the actionable half of its answer:
                "Last seen 2h ago", when reachability was checked, that remote
                access needs an upgrade. Suppressing those left them rendered
                nowhere, since the picker deliberately shows only a dot. */}
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

/**
 * What is working on this host, as a state rather than a clause.
 *
 * This is what is left of the `via relay.dev.traycer.ai · 1 active session`
 * meta row. The route half is deliberately gone — a relay origin is not
 * something anyone acts on from this page, and printing it made a monospace
 * band out of the one fact that IS actionable: whether work is running on this
 * host right now, which decides whether Restart is safe to press.
 *
 * Copy comes from {@link describeHostBusy}. A null label renders nothing: a
 * host that has not answered `host.status` has not told us it is idle, and
 * "Idle" is a claim. Live (emerald, pulsing) only when `busy` — an idle
 * shell must not light the chip. Fill is an alpha of the foreground, never
 * `bg-muted`: this chip sits on a card, and muted collapses into the card
 * on most preset darks.
 */
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
