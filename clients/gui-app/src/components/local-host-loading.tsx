import { useEffect, useId, useRef, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  HOST_PROGRESS_IDLE_HEADING,
  type HostProgressView,
} from "@/lib/host/host-progress-copy";
import { Button } from "@/components/ui/button";
import { HostBootHeadline } from "@/components/centered-card";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useHostBootDetailsStore } from "@/stores/host/host-boot-details-store";
import { useRunnerTraycerHostStatusQuery } from "@/hooks/runner/use-runner-traycer-host-status-query";

/**
 * Poll cadence for the bootstrap.log tail while details are open. Tight
 * enough to feel live; only runs while the disclosure is expanded so the
 * CLI subprocess cost is paid only when the user is actively watching.
 */
const BOOTSTRAP_TAIL_POLL_MS = 1500;

export interface BootstrapLogDisclosureProps {
  readonly onConfigureShell: () => void;
  /**
   * A second control to sit BESIDE the toggle on its row, or `null`.
   *
   * The boot card's footer is one row, not a stack: `Show details` and
   * `Open settings` on separate centred lines turned a two-line card into a
   * four-line square with a column of unrelated-looking links down the middle.
   * Required rather than optional so every call site states whether it has a
   * neighbour - a defaulted slot is how one surface silently grows a footer
   * the others do not have, which is the inconsistency this family keeps
   * regrowing.
   */
  readonly trailing: ReactNode | null;
}

/**
 * The bootstrap.log tail and the "Configure shell…" shortcut, behind one text
 * toggle.
 *
 * Exported separately from {@link LocalHostLoadingContent} because the two are
 * true in different states. The log affordance is the one thing that lets a
 * user take a stuck startup somewhere else, so it belongs on the FAILED arm as
 * well - while the spinner and the progress heading belong only to a start that
 * is actually in progress. Composing it beside the failure diagnostics is how
 * the failed arm gets the log without the "Starting local Traycer Host…" lie,
 * and it keeps `LocalHostLoadingContent`'s one-purpose rule intact rather than
 * regrowing the second face P3.4 deleted.
 */
export function BootstrapLogDisclosure(
  props: BootstrapLogDisclosureProps,
): ReactNode {
  const runnerHost = useRunnerHost();
  // STORE-BACKED, not component state: this disclosure is drawn by three
  // different surfaces across one launch, and each hand-off unmounts it - so a
  // local flag closed the log every time the boot moved on. See
  // `useHostBootDetailsStore`.
  const showDetails = useHostBootDetailsStore((state) => state.open);
  const setShowDetails = useHostBootDetailsStore((state) => state.setOpen);
  // Only poll while the disclosure is open. Cache stays warm if the user
  // toggles closed-then-open quickly.
  const status = useRunnerTraycerHostStatusQuery({
    pollIntervalMs: showDetails ? BOOTSTRAP_TAIL_POLL_MS : null,
    onMount: "when-stale",
  });
  // No CLI, no bootstrap log - but a neighbour control still has to render, or
  // the footer disappears entirely on shells that never had a log to offer.
  if (runnerHost.traycerCli === null) {
    return props.trailing === null ? null : (
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        {props.trailing}
      </div>
    );
  }
  return (
    <DetailsDisclosure
      open={showDetails}
      onToggle={() => {
        setShowDetails(!showDetails);
      }}
      tail={status.data?.bootstrapLogTail ?? ""}
      onConfigureShell={props.onConfigureShell}
      trailing={props.trailing}
    />
  );
}

/**
 * The ONE alignment contract for a local-bootstrap body.
 *
 * Both bodies were fragments, so their children became direct children of the
 * dialog's own `flex flex-col gap-4` column and each one carried (or failed to
 * carry) its own alignment. Same defect in both, but NOT the same history, and
 * the difference is worth keeping straight: the loading body lost its contract
 * (every consumer that supplied a wrapper was deleted, leaving one that supplies
 * none), while the ∅ body never had one - it was authored as a fragment into a
 * `gap-4` column. Nothing was deleted from under it.
 *
 * THE COUNT, since two different threes have been cited. The rendered-evidence
 * count is the CLOSED card and its members are: the left-aligned body, the
 * centred toggle, and the right-aligned action footer - which branch-left
 * deliberately KEEPS, because a footer is not part of the body's column. The
 * other three is the OPEN card measured by
 * `scripts/window-host-modal-alignment-browser.mjs` (body, centred toggle label,
 * centred `Configure shell…`) and excludes the footer entirely. Cite the closed
 * card's three; it is the one the variants were shot against.
 *
 * Branch-left, decided on rendered full-modal screenshots. Base-centred was
 * rejected on that evidence because it recreates the same defect with different
 * members. `self-start` on the toggle is rejected for a sharper reason: it
 * shrink-wraps the button, which makes a stray `justify-center` INVISIBLE rather
 * than absent. That is exactly why one rendered variant looked fixed while still
 * carrying `justify-center`. Dropping both classes removes the defect;
 * `self-start` would only hide it - and hide it from this file's own harness too,
 * which measures a position that `self-start` and the real fix both produce.
 * Alignment belongs to this root, not to each leaf that remembers to ask.
 *
 * `gap-4` deliberately matches the dialog column's own gap, so introducing this
 * root preserves the existing vertical rhythm instead of quietly re-spacing a
 * surface whose spacing nobody asked to change.
 */
export function LocalHostBodyShell(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      data-testid="local-host-body"
      // align-ok: the boot card is centred (see `HostBootCard`) - this column
      // inherits that decision rather than fighting it from one level down.
      className="flex w-full flex-col items-center gap-4 text-center"
    >
      {props.children}
    </div>
  );
}

export interface LocalHostLoadingContentProps {
  /**
   * The shared host-progress view (F19's one copy table), not a raw lane
   * event. Built by the caller so this body and Settings ▸ Host read the same
   * table: they used to phrase the same install two different ways, one keyed
   * on the progress stage and one on the mutation kind.
   */
  readonly progress: HostProgressView | null;
  readonly onConfigureShell: () => void;
  /** A peer control for the footer row - see {@link BootstrapLogDisclosureProps}. */
  readonly footerTrailing: ReactNode | null;
}

/**
 * The host-boot body: spinner + heading, the progress bar, and the
 * bootstrap-log disclosure (with the "Configure shell…" shortcut).
 * Deliberately has no outer chrome (no `min-h-svh` wrapper, no `<AppHeader>`,
 * no `<Card>`) so its caller provides its own bounded layout.
 *
 * ONE PURPOSE, since P3.4: this describes a start that is still in progress,
 * and nothing else. It used to take a `stage` and grow a second face on
 * `"slow"` - its own "taking longer than expected" copy, its own Retry, and
 * the failed-attempt summary. Every caller of that arm is gone: the modal
 * (now the only caller) passes a start that is progressing and states its
 * actions in one row of its own, drawing the attempt diagnostics beside this
 * body on the arm where they are true. A body with no branch cannot disagree
 * with the surface it sits in about what is happening.
 *
 * ONE HEIGHT, whatever the lane has said. Every member of this body is drawn
 * on every call - `progress: null` (no lane yet) draws the idle heading over
 * an indeterminate bar, a reporting lane draws its heading over a filling
 * bar - so the same body serves the two boot surfaces BEFORE the narrator
 * (`HostBootSurface`) and the narrator's healthy face itself, and the card is
 * one box from the first frame of a launch until a lane finishes. It used to
 * add the bar (and a lane-detail line) only once a lane reported, which made
 * the card grow mid-wait; on a centred card that moves both edges, and it was
 * reported after a real install as "3-4 different modals … the UI feels jumpy
 * when the modal size keeps changing".
 *
 * NO LANE-DETAIL LINE. `HostProgressView.detail` is the lane's own message -
 * "extracting host archive into ~/.traycer/…/staging", "atomically replacing
 * install directory" - a log line with a path in it, not a sentence for a
 * launch card, and its arrival was one of the shapes in that report. The
 * heading (`hostProgressHeading`) already names the phase in the user's
 * words; the detail stays in the shared table for Settings ▸ Host, where a
 * user has gone looking for it.
 */
export function LocalHostLoadingContent(
  props: LocalHostLoadingContentProps,
): ReactNode {
  const progressView = props.progress;

  return (
    <LocalHostBodyShell>
      {/* THE ONE HEADING this surface has, and the spinner belongs TO it.
          The healthy startup card renders no dialog title above this body
          anymore - the old modal put "Setting up Traycer" 2px above this
          line's "Setting up Traycer Host…" above the bar's "Setting up…", one
          event announced three times by three layers.

          Drawn through the SHARED boot headline so this phase is
          pixel-identical to the two boot surfaces before it (see
          `HostBootCard`): a launch crosses three React trees, and the spinner
          used to jump from small-and-muted-and-centred to
          large-and-foreground-on-its-own-line as it did. The COPY still comes
          from D10's shared table. */}
      <HostBootHeadline
        message={progressView?.heading ?? HOST_PROGRESS_IDLE_HEADING}
        spinnerVariant="sparkle"
        spinnerTestId="local-host-loading-spinner"
        messageTestId="local-host-loading-stage"
      />
      {/* THE CONTRACT, not a special case: no measured position => indeterminate.
          That covers a lane that reports no percentage (`verify`, `swap`,
          `service-start`, anything added later) AND the wait before any lane
          has spoken - both are "busy, position unknown", which is exactly what
          an indeterminate `progressbar` means. The block is the CURRENT
          stage's, not "the download's": it stopped being that the moment the
          carry-forward was scoped to one stage. */}
      <HostProgress percent={progressView?.percent ?? null} />
      <BootstrapLogDisclosure
        onConfigureShell={props.onConfigureShell}
        trailing={props.footerTrailing}
      />
    </LocalHostBodyShell>
  );
}

interface HostProgressProps {
  /** `null` while nothing has a measured position - see the contract above. */
  readonly percent: number | null;
}

/**
 * The boot card's ONE progress bar: determinate when the running stage
 * reports a percentage, indeterminate otherwise - and present on EVERY wait
 * face, the idle "Starting Traycer…" included.
 *
 * WHY IT RENDERS AT ALL WITHOUT A NUMBER. Before this, the block was gated on
 * `percent !== null`, so at a stage transition the whole thing unmounted and the
 * card lost 48px - and because the modal is centred with `-translate-y-1/2`, both
 * of its edges moved 24px and the whole dialog jumped mid-install. Measured, on
 * the one surface this epic exists to fix. Holding the space is the point - and
 * it now holds it from the first frame of the launch (see
 * `LocalHostLoadingContent`), because a bar that appeared when the lane began
 * reporting was the same jump one phase earlier.
 *
 * NO BYTES. This row used to carry "100 MB of 239 MB" beside the percentage.
 * On a card that is on screen the moment the app opens, a byte count reads as
 * "Traycer began downloading something because I launched it" - reported as
 * alarming - where a percentage reads as the same start progressing. The
 * transfer figures stay in the shared table (`HostProgressView.transferLabel`)
 * for Settings ▸ Host, where a user has gone looking for them.
 *
 * ⚠ AND IT MUST NOT HIDE A STALL. It cannot: stall detection is entirely the
 * staged wait's (`LOCAL_HOST_SLOW_START_THRESHOLD_MS` and
 * `laneProgressAdvanceKey`), which reads the lane's POSITION and promotes to the
 * Retry surface on its own clock. A genuinely wedged extract still gets there
 * while this animates. The two mechanisms compose and neither is load-bearing for
 * the other - worth knowing before anyone "fixes" this bar to stop after a while.
 */
function HostProgress(props: HostProgressProps) {
  const indeterminate = props.percent === null;
  return (
    <div
      data-testid="local-host-download-progress"
      data-indeterminate={indeterminate ? "true" : "false"}
      // `items-center`: the figure below the track centres, like everything
      // else on this card (heading above, footer below). A right-aligned
      // figure with nothing on its left - which is what dropping the byte
      // count left behind - hung off the track's end like an orphan.
      className="flex w-full flex-col items-center gap-2"
    >
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        // Omitted while indeterminate, which is what the ARIA role means by it -
        // a `progressbar` with no `aria-valuenow` is announced as busy with an
        // unknown position, rather than as a specific amount done.
        aria-valuenow={props.percent ?? undefined}
        // Thin, fully rounded, and CLIPPED: `overflow-hidden` is what keeps
        // the sweeping segment (which travels from -100% to +340% of its own
        // width) inside the track's rounded ends, and the track is `w-full`
        // of the body column, so it can never run past the card's padding.
        // The track's fill is an alpha of the foreground, which survives
        // every preset theme on a raised surface (see AGENTS.md).
        className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/8"
      >
        {indeterminate ? (
          // A SWEEPING SEGMENT, not a pulsing full-width fill: a full bar reads as
          // finished however it is animated, which is the exact lie the scoped
          // carry-forward removed. `w-2/5` + a translate keeps it obviously
          // partial. `animation` inline because the keyframe is app CSS
          // (`index.css`) and there is no utility for it.
          <div
            data-testid="local-host-progress-indeterminate"
            className="h-full w-2/5 rounded-full bg-primary"
            style={{
              animation:
                "host-progress-indeterminate 1.4s ease-in-out infinite",
            }}
          />
        ) : (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${String(props.percent)}%` }}
          />
        )}
      </div>
      {/* The percentage ONLY, under the track. This slot used to sit above
          the bar and fall back to the stage's short label ("Setting up…"),
          which merely repeated the heading two lines up in fewer words - the
          third of the three "Setting up"s - and later carried the byte count
          (see above). The row keeps its height either way so a percentage
          appearing at the download stage does not bounce the centred card,
          and `tabular-nums` keeps "9%" -> "10%" from shifting as it counts.

          `min-h-[1lh]`, not a fixed `min-h-4`: the reserved slot is exactly
          one line OF THIS ROW, so it follows `text-ui-xs`'s line height
          instead of restating today's value of it in `rem` - the two agree
          now and a token change is where they would stop. The unit is
          already used across the composer surfaces. */}
      <div className="flex min-h-[1lh] items-center justify-center text-ui-xs text-muted-foreground tabular-nums">
        {indeterminate ? null : <span>{props.percent}%</span>}
      </div>
    </div>
  );
}

interface DetailsDisclosureProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly tail: string;
  readonly onConfigureShell: () => void;
  readonly trailing: ReactNode | null;
}

/**
 * Tucks the bootstrap.log tail and the "Configure shell…" affordance
 * behind a single text toggle. The default loading card stays clean
 * (spinner + heading + optional Retry); users only see logs and the
 * shell-settings shortcut when they explicitly ask.
 */
function DetailsDisclosure(props: DetailsDisclosureProps) {
  const Icon = props.open ? ChevronUp : ChevronDown;
  // The toggle names the region it expands. Kept in the DOM with `hidden`
  // rather than unmounted so the id `aria-controls` points at always resolves -
  // a dangling `aria-controls` is worse than none, since assistive tech reports
  // a control that operates nothing. `hidden` is `display: none`, so a closed
  // region contributes no gap to the column either.
  const regionId = useId();
  return (
    <div className="flex w-full flex-col items-center gap-3">
      {/* ONE footer row. The toggle and whatever sits beside it are peers of
          equal weight, so they read as a footer rather than as a column of
          stray links - which is what two centred lines produced. */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        <button
          type="button"
          onClick={props.onToggle}
          aria-expanded={props.open}
          aria-controls={regionId}
          data-testid="local-host-loading-toggle-details"
          // Shrink-wrapped and centred by the parent's `items-center`, so the hit
          // area matches the text. The card is centred now (see `HostBootCard`),
          // which retires the older `items-stretch` arrangement: that existed to
          // keep a stray `justify-center` VISIBLE while the column was
          // left-aligned, and there is no longer a left edge for it to violate.
          className="inline-flex items-center gap-1 text-ui-xs text-muted-foreground hover:text-foreground"
        >
          <span>{props.open ? "Hide details" : "Show details"}</span>
          <Icon className="size-3" />
        </button>
        {props.trailing}
      </div>
      <div
        id={regionId}
        hidden={!props.open}
        className="flex w-full flex-col gap-3"
      >
        {props.open ? (
          <>
            <BootstrapLogTail tail={props.tail} />
            {/* align-ok: a lone control centred under the log it belongs to. */}
            <div className="flex justify-center">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={props.onConfigureShell}
                data-testid="local-host-open-shell-settings"
              >
                Configure shell…
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

interface BootstrapLogTailProps {
  readonly tail: string;
}

/**
 * Live tail of `~/.traycer/bootstrap.log`. Auto-scrolls to the bottom on
 * every refresh so the most recent line stays visible - same UX as a
 * `tail -f` in a terminal pane.
 */
function BootstrapLogTail(props: BootstrapLogTailProps) {
  const ref = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [props.tail]);

  if (props.tail.length === 0) {
    return (
      <p
        data-testid="local-host-loading-empty-tail"
        // `text-left`, decided rather than inherited. This was `text-center`,
        // which made it the last leaf overriding the body's one-alignment
        // contract - and it is the SAME SLOT as the `<pre>` below, which is
        // `text-left`, so the two states of one region disagreed about where
        // their text starts. Content appearing to shift for a reason unrelated
        // to the content is what that reads as.
        //
        // Not a rare branch, either: on the ∅ arm the host never reported ready,
        // so an empty tail is the EXPECTED reading, not an edge case - and it is
        // the one branch the alignment harness does not enter.
        //
        // ⚠ NOTHING EVALUATES THE WAIVER BELOW, and that is a property of THIS
        // FILE rather than of the waiver. `muted-fill-on-raised-surface-lint`
        // walks imports DOWNWARD from a file that spells a raised-surface token;
        // this component is a dialog body composed by its CALLER and passed in as
        // a prop, so the edge runs the other way and no hop count reaches it -
        // measured out of scope at 1, 2 AND 3 hops. Both waivers in this file are
        // therefore a claim NOBODY CHECKS. They are kept because they are true
        // (both fills are /30 behind their own border, which the guard's own
        // `isLoadBearing` would clear anyway), and because a reader who deletes
        // them will assume the sweep covers this file. It does not. A fill added
        // here is guarded by the AGENTS.md rule and a human, and by nothing else.
        //
        // The waiver stays LAST, adjacent to the class list it excuses: the
        // muted-fill guard only looks a few lines back, so prose inserted between
        // the two silently orphans it. That is what happened here - the comment
        // above was added later and pushed the marker out of range. Kept in force
        // for the day this file does come into scope.
        // align-ok: a log slot reads left-to-right inside its own bordered
        // box - and it must match the <pre> that replaces it, or the two
        // states of one region would start their text in different places.
        // muted-fill-ok: weak tint delimited by its own border-border/60
        className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left text-ui-xs text-muted-foreground"
      >
        Waiting for bootstrap output…
      </p>
    );
  }

  return (
    <pre
      ref={ref}
      data-testid="local-host-loading-log-tail"
      // The second of this file's two unevaluated waivers - see the note on the
      // empty-tail branch above for why nothing in CI reads either of them.
      // align-ok: log output is left-to-right by nature; centring a tail
      // would make every line start at a different column.
      // muted-fill-ok: weak tint delimited by its own border-border/60
      className="max-h-72 w-full overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left font-mono text-code-xs text-muted-foreground"
    >
      {props.tail}
    </pre>
  );
}
