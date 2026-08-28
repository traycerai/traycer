import type { ReactNode } from "react";
import { HostGlyph } from "@/components/settings/host-scope/host-glyph";
import {
  hostOptionKindLabel,
  hostOptionStatusWord,
  hostOptionUpdateBadge,
  type HostPickIntent,
  type HostRowSurfaceState,
} from "@/components/settings/host-scope/host-option-model";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { FleetUpdateView } from "@/lib/host/fleet-update/fleet-update-view";
import { cn } from "@/lib/utils";

/**
 * ONE host row: kind glyph · name · [ACTIVE] · update badge · exception status.
 *
 * This is the whole shared vocabulary, and it is deliberately content only —
 * no button, no `CommandItem`, no list semantics. The containers differ in ways
 * that are theirs to own (a cmdk item in a combobox, a radio in a dialog, a row
 * in a section of another popover), and forcing one interaction shell on all of
 * them is what would make the shared picker sit badly in each. What must not
 * differ is this: three pickers each inventing their own icon set and their own
 * word for "offline" is exactly what this replaced.
 *
 * Single-line by design. Healthy hosts stay quiet; only exception states get a
 * status word. The interaction container owns the trailing selection check so
 * the row does not reserve two competing selection columns.
 */
export function HostOptionRow(props: {
  readonly host: HostScopeOption;
  /** The row this surface is currently pointed at. */
  readonly picked: boolean;
  /** The app-wide active host — where new work lands. */
  readonly active: boolean;
  readonly intent: HostPickIntent;
  /**
   * What this surface is saying about the row, as one value — see
   * `HostRowSurfaceState`. A union so "inert" and "refused with a word" cannot
   * both be true of one row.
   */
  readonly surfaceState: HostRowSurfaceState;
  /**
   * This host's projected update state, or `null` for a surface that does not
   * show update state at all.
   *
   * OPT-IN BY DATA, not by a boolean flag, and that is the whole enforcement of
   * the "fleet update state lives in Settings" decision. Only the Settings host
   * switcher passes a view; every other picker on this shared row — the header
   * usage popover, the Select host dialog, the per-surface pin pickers — passes
   * `null` and renders no badge.
   *
   * A `showUpdateBadge: boolean` would have been the obvious shape and the
   * wrong one: it can be flipped true without wiring a source, and the natural
   * source to reach for would be a per-row query — which is exactly the
   * "Settings does not silently connect to other hosts to improve their badges"
   * rule inverted. Requiring the caller to hand over an already-observed view
   * means a surface can only show a badge for state it already had.
   */
  readonly updateView: FleetUpdateView | null;
}): ReactNode {
  const { host } = props;
  // Includes "setting up" (M5): host-scope narration for a local host being
  // installed. When another host can serve the window that setup is NOT a
  // window-wide event — the global modal deliberately stays away, and this row
  // plus Settings' progress banner are where it shows instead.
  const statusWord = hostOptionStatusWord(host, props.surfaceState);
  // Two INDEPENDENT words, and a row may carry both — "offline · update failed"
  // is a real and useful pair. They are not merged because they answer
  // different questions (route/health vs update), which is the distinction
  // `hostOptionUpdateBadge` documents at length.
  //
  // An inert row stays silent about updates too: when the surface has put the
  // row out of reach it owns the entire explanation, and an update badge beside
  // that refusal reads as a second, unrelated problem with that machine.
  // `updateView === null` is the OPT-OUT and must short-circuit to `null`. It
  // must never be substituted with a fabricated view: doing so badges every row
  // of the three pickers that deliberately pass `null`, which is the exact leak
  // the opt-in exists to prevent — and a cast is what would let it type-check.
  const updateBadge =
    props.updateView === null || props.surfaceState.kind === "inert"
      ? null
      : hostOptionUpdateBadge(props.updateView);
  // The ACTIVE tag exists to separate two marks that can disagree: what you are
  // VIEWING versus what this window runs on. Under `bind` they are the same
  // fact by definition, so the tag would restate the check it sits next to.
  const showActiveTag = props.intent === "view" && props.active;
  return (
    <>
      <HostGlyph
        host={host}
        className="size-4 shrink-0 text-muted-foreground"
      />
      <span className="sr-only">{hostOptionKindLabel(host)}</span>
      <span className="min-w-0 flex-1 truncate text-start">{host.name}</span>
      {props.picked && props.intent === "view" ? (
        <span className="sr-only">Currently viewing</span>
      ) : null}
      {showActiveTag ? <ActiveTag /> : null}
      {updateBadge === null ? null : (
        <span
          className="shrink-0 text-ui-xs text-muted-foreground"
          data-testid={`host-option-update-badge-${host.hostId}`}
        >
          {updateBadge}
        </span>
      )}
      {statusWord === null ? null : (
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {statusWord}
        </span>
      )}
    </>
  );
}

/**
 * The accent is reserved for the BINDING — which host this window uses. It
 * never marks the viewing selection, so the two can always be told apart at a
 * glance even when they happen to be the same host.
 */
function ActiveTag(): ReactNode {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm bg-primary/15 px-1 py-px",
        "text-[0.625rem] font-medium uppercase tracking-wide text-primary",
      )}
    >
      Active
    </span>
  );
}
