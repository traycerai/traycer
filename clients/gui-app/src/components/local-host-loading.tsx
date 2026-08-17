import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  HOST_PROGRESS_IDLE_HEADING,
  type HostProgressView,
} from "@/lib/host/host-progress-copy";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useRunnerTraycerHostStatusQuery } from "@/hooks/runner/use-runner-traycer-host-status-query";

/**
 * Poll cadence for the bootstrap.log tail while details are open. Tight
 * enough to feel live; only runs while the disclosure is expanded so the
 * CLI subprocess cost is paid only when the user is actively watching.
 */
const BOOTSTRAP_TAIL_POLL_MS = 1500;

export interface BootstrapLogDisclosureProps {
  readonly onConfigureShell: () => void;
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
  const [showDetails, setShowDetails] = useState<boolean>(false);
  // Only poll while the disclosure is open. Cache stays warm if the user
  // toggles closed-then-open quickly.
  const status = useRunnerTraycerHostStatusQuery({
    pollIntervalMs: showDetails ? BOOTSTRAP_TAIL_POLL_MS : null,
  });
  if (runnerHost.traycerCli === null) return null;
  return (
    <DetailsDisclosure
      open={showDetails}
      onToggle={() => setShowDetails((v) => !v)}
      tail={status.data?.bootstrapLogTail ?? ""}
      onConfigureShell={props.onConfigureShell}
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
      className="flex w-full flex-col gap-4 text-left"
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
}

/**
 * The host-boot body: spinner, progress heading/detail, the download progress
 * bar, and the bootstrap-log disclosure (with the "Configure shell…"
 * shortcut). Deliberately has no outer chrome (no `min-h-svh` wrapper, no
 * `<AppHeader>`, no `<Card>`) so its caller provides its own bounded layout.
 *
 * ONE PURPOSE, since P3.4: this describes a start that is still in progress,
 * and nothing else. It used to take a `stage` and grow a second face on
 * `"slow"` - its own "taking longer than expected" copy, its own Retry, and
 * the failed-attempt summary. Every caller of that arm is gone: the modal
 * (now the only caller) passes a start that is progressing and states its
 * actions in one row of its own, drawing the attempt diagnostics beside this
 * body on the arm where they are true. A body with no branch cannot disagree
 * with the surface it sits in about what is happening.
 */
export function LocalHostLoadingContent(
  props: LocalHostLoadingContentProps,
): ReactNode {
  const progressView = props.progress;

  return (
    <LocalHostBodyShell>
      <AgentSpinningDots
        testId="local-host-loading-spinner"
        variant="pulse"
        className="h-8 min-w-8 text-title-md text-foreground"
      />
      {/* The STAGE, subordinate to the modal's title - not a second heading.
          It used to be `text-ui font-medium text-foreground`, which put it 2px
          from the dialog title at the identical weight and colour, so one event
          arrived as two competing headings ("Setting up Traycer" above
          "Setting up Traycer Host…").

          Demoted in SIZE and COLOUR, which is the endorsed variant. `font-medium`
          is deliberately KEPT rather than dropped: the lane's own detail line
          directly below is already `text-ui-sm text-muted-foreground`, so
          dropping weight too would make the stage byte-identical to the message
          it is meant to caption, and the modal description above it is that
          same pair. Weight is the one channel left that separates the three.

          The COPY is untouched on purpose. `hostProgressHeading` is D10's shared
          one-wording-per-event table, read by Settings ▸ Host as well; rewording
          it here to reduce a within-surface duplication would break the
          across-surface rule that table exists to enforce. */}
      <p
        data-testid="local-host-loading-stage"
        className="text-ui-sm font-medium text-muted-foreground"
      >
        {progressView?.heading ?? HOST_PROGRESS_IDLE_HEADING}
      </p>
      <ProgressLines view={progressView} />
      <BootstrapLogDisclosure onConfigureShell={props.onConfigureShell} />
    </LocalHostBodyShell>
  );
}

/**
 * The lane's detail line and its progress bar, both of which only exist when
 * the lane has said something. Split out of the body so the body's branch
 * count stays about its own layout rather than about the view's optionality.
 */
function ProgressLines(props: {
  readonly view: HostProgressView | null;
}): ReactNode {
  const { view } = props;
  if (view === null) return null;
  return (
    <>
      {view.detail === null ? null : (
        <p
          data-testid="local-host-loading-progress-detail"
          className="text-ui-sm text-muted-foreground"
        >
          {view.detail}
        </p>
      )}
      {view.percent === null ? null : (
        <HostDownloadProgress
          percent={view.percent}
          shortLabel={view.shortLabel}
          transferLabel={view.transferLabel}
        />
      )}
    </>
  );
}

interface HostDownloadProgressProps {
  readonly percent: number;
  readonly shortLabel: string;
  readonly transferLabel: string | null;
}

function HostDownloadProgress(props: HostDownloadProgressProps) {
  return (
    <div
      data-testid="local-host-download-progress"
      className="flex w-full flex-col gap-2"
    >
      <div className="flex items-center justify-between text-ui-xs text-muted-foreground">
        <span>{props.transferLabel ?? props.shortLabel}</span>
        <span className="font-medium text-foreground">{props.percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={props.percent}
        className="h-2 w-full overflow-hidden rounded-full bg-foreground/8"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${props.percent}%` }}
        />
      </div>
    </div>
  );
}

interface DetailsDisclosureProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly tail: string;
  readonly onConfigureShell: () => void;
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
    <div className="flex w-full flex-col items-stretch gap-3">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        aria-controls={regionId}
        data-testid="local-host-loading-toggle-details"
        // No `self-center` and no `justify-center`: alignment is the shell's,
        // and this control centring itself is what made the card read as three
        // alignments (see the shell's doc for which three).
        //
        // NOT `self-start` either, and not because it is untried - it was
        // rendered. Because it shrink-wraps this button, which makes a stray
        // `justify-center` a NO-OP: one rendered variant looked fixed while
        // still carrying the class. `self-start` hides this defect where
        // dropping both removes it.
        //
        // The consequence, accepted deliberately: with `items-stretch` on the
        // parent, this button's box spans the card while its label sits left, so
        // the hit area is wider than the text. Harmless here - it is a lone
        // control on its row, with nothing adjacent to mis-hit - and the wide box
        // is what keeps a re-added `justify-center` VISIBLE instead of masked.
        // Shrink-wrapping it (`w-fit` as much as `self-start`) would buy a
        // tidier target and reintroduce the blind spot.
        className="inline-flex items-center gap-1 text-ui-xs text-muted-foreground hover:text-foreground"
      >
        <span>{props.open ? "Hide details" : "Show details"}</span>
        <Icon className="size-3" />
      </button>
      <div
        id={regionId}
        hidden={!props.open}
        className="flex w-full flex-col gap-3"
      >
        {props.open ? (
          <>
            <BootstrapLogTail tail={props.tail} />
            <div className="flex">
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
        // muted-fill-ok: weak tint delimited by its own border-border/60
        //
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
      // muted-fill-ok: weak tint delimited by its own border-border/60
      className="max-h-72 w-full overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left font-mono text-code-xs text-muted-foreground"
    >
      {props.tail}
    </pre>
  );
}
