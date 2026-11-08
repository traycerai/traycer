import type { ReactNode, Ref } from "react";
import { HOST_FROZEN_WORD } from "@traycer/protocol/host/host-status";
import { Badge } from "@/components/ui/badge";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
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
 * Shared content for every host picker: a single-line name beside its state
 * and marks. The full name remains available when space cuts it off. The interaction shell owns selection and the trailing check.
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
  /**
   * The name's element, for a surface that tells when its width has cut the
   * name (the account menu's tooltip), or `null`.
   */
  readonly nameRef: Ref<HTMLSpanElement>;
  /**
   * The environment this host runs (Tracy Bots), or `null` for a picker that
   * does not say - which is every picker but Settings' host list, the one
   * place the person changes it.
   */
  readonly environmentLabel: string | null;
}): ReactNode {
  const {
    host,
    picked,
    active,
    intent,
    surfaceState,
    updateView,
    nameRef,
    environmentLabel,
  } = props;
  // Includes "setting up" (M5): host-scope narration for a local host being
  // installed. When another host can serve the window that setup is NOT a
  // window-wide event — the global modal deliberately stays away, and this row
  // plus Settings' progress banner are where it shows instead.
  const statusWord = hostOptionStatusWord(host, surfaceState);
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
    updateView === null || surfaceState.kind === "inert"
      ? null
      : hostOptionUpdateBadge(updateView);
  // The ACTIVE tag exists to separate two marks that can disagree: what you are
  // VIEWING versus what this window runs on. Under `bind` they are the same
  // fact by definition, so the tag would restate the check it sits next to.
  const showActiveTag = intent === "view" && active;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <HostGlyph
        host={host}
        className="size-4 shrink-0 text-muted-foreground"
      />
      <span className="sr-only">{hostOptionKindLabel(host)}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2 text-start">
        <TooltipWrapper
          label={nameRef === null ? host.name : null}
          side="top"
          sideOffset={6}
          align={undefined}
        >
          <span ref={nameRef} className="min-w-0 flex-1 truncate">
            {host.name}
          </span>
        </TooltipWrapper>
        {picked && intent === "view" ? (
          <span className="sr-only">Currently viewing</span>
        ) : null}
        <HostOptionMarks
          host={host}
          statusWord={statusWord}
          updateBadge={updateBadge}
          environmentLabel={environmentLabel}
          showActiveTag={showActiveTag}
        />
      </span>
    </span>
  );
}

/** Status and marks stay beside the name; truncation retains their full text. */
function HostOptionMarks(props: {
  readonly host: HostScopeOption;
  readonly statusWord: string | null;
  readonly updateBadge: string | null;
  readonly environmentLabel: string | null;
  readonly showActiveTag: boolean;
}): ReactNode {
  const { host, statusWord, updateBadge, environmentLabel, showActiveTag } =
    props;
  if (
    !showActiveTag &&
    environmentLabel === null &&
    updateBadge === null &&
    statusWord === null &&
    host.terminalRunNote === null
  )
    return null;
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-2 text-ui-xs whitespace-nowrap text-muted-foreground">
      {host.terminalRunNote === null ? null : (
        <TooltipWrapper
          label={host.terminalRunNote}
          side="top"
          sideOffset={6}
          align={undefined}
        >
          <span
            className="max-w-32 truncate"
            data-testid={`host-option-terminal-run-${host.hostId}`}
          >
            {host.terminalRunNote}
          </span>
        </TooltipWrapper>
      )}
      {statusWord === null ? null : <span>{statusWord}</span>}
      {statusWord !== null && host.sandbox?.frozen ? (
        <Badge variant="warning">{HOST_FROZEN_WORD}</Badge>
      ) : null}
      {showActiveTag ? <ActiveTag /> : null}
      {environmentLabel === null ? null : (
        <span data-testid={`host-option-environment-${host.hostId}`}>
          {environmentLabel}
        </span>
      )}
      {updateBadge === null ? null : (
        <span data-testid={`host-option-update-badge-${host.hostId}`}>
          {updateBadge}
        </span>
      )}
    </span>
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
