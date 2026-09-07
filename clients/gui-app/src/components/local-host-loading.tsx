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

/** Poll cadence for the bootstrap.log tail while details are open. Tight enough to feel live; only runs while
 * the disclosure is expanded so the CLI subprocess cost is paid only when the user is actively watching. */
const BOOTSTRAP_TAIL_POLL_MS = 1500;

export interface BootstrapLogDisclosureProps {
  readonly onConfigureShell: () => void;
  /** Required rather than optional so every call site states whether it has a neighbour. */
  readonly trailing: ReactNode | null;
}

/** Composing it beside the failure diagnostics is how the failed arm gets the log without the "Starting local
 * Traycer Host…" lie. */
export function BootstrapLogDisclosure(
  props: BootstrapLogDisclosureProps,
): ReactNode {
  const runnerHost = useRunnerHost();
  // Store-backed, not component state: this disclosure is drawn by three different surfaces across one launch,
  // and each hand-off unmounts it - so a local flag closed the log every time the boot moved on.
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

/** Dropping both classes removes the defect; `self-start` would only hide it - and hide it from this file's own
 * harness too, which measures a position that `self-start` and the real fix both produce. */
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
  /** The shared host-progress view, not a raw lane event. */
  readonly progress: HostProgressView | null;
  readonly onConfigureShell: () => void;
  readonly footerTrailing: ReactNode | null;
}

/** A body with no branch cannot disagree with the surface it sits in about what is happening. */
export function LocalHostLoadingContent(
  props: LocalHostLoadingContentProps,
): ReactNode {
  const progressView = props.progress;

  return (
    <LocalHostBodyShell>
      {/* The healthy startup card renders no dialog title above this body anymore. */}
      <HostBootHeadline
        message={progressView?.heading ?? HOST_PROGRESS_IDLE_HEADING}
        spinnerVariant="sparkle"
        spinnerTestId="local-host-loading-spinner"
        messageTestId="local-host-loading-stage"
      />
      {/* The contract, not a special case: no measured position => indeterminate. The block is the current stage's,
         not "the download's": it stopped being that the moment the carry-forward was scoped to one stage. */}
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

/** And it must not hide a stall. */
function HostProgress(props: HostProgressProps) {
  const indeterminate = props.percent === null;
  return (
    <div
      data-testid="local-host-download-progress"
      data-indeterminate={indeterminate ? "true" : "false"}
      // `items-center`: the figure below the track centres, like everything else on this card (heading above, footer
      // below).
      className="flex w-full flex-col items-center gap-2"
    >
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        // Omitted while indeterminate, which is what the ARIA role means by it - a `progressbar` with no
        // `aria-valuenow` is announced as busy with an unknown position, rather than as a specific amount done.
        aria-valuenow={props.percent ?? undefined}
        // `overflow-hidden` clips the sweep to the rounded track. Fill is a foreground alpha.
        className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/8"
      >
        {indeterminate ? (
          // A sweeping segment, not a pulsing full-width fill: a full bar reads as finished however it is animated,
          // which is the exact lie the scoped carry-forward removed.
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
      {/* `min-h-[1lh]`, not a fixed `min-h-4`: the reserved slot is exactly one line OF this row, so it follows
         `text-ui-xs`'s line height instead of restating today's value of it in `rem`. */}
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

/** The default loading card stays clean (spinner + heading + optional Retry); users only see logs and the
 * shell-settings shortcut when they explicitly ask. */
function DetailsDisclosure(props: DetailsDisclosureProps) {
  const Icon = props.open ? ChevronUp : ChevronDown;
  // Kept in the DOM with `hidden` rather than unmounted so the id `aria-controls` points at always resolves - a
  // dangling `aria-controls` is worse than none, since assistive tech reports a control that operates nothing.
  const regionId = useId();
  return (
    <div className="flex w-full flex-col items-center gap-3">
      {/* The toggle and whatever sits beside it are peers of equal weight, so they read as a footer rather than as a
         column of stray links - which is what two centred lines produced. */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        <button
          type="button"
          onClick={props.onToggle}
          aria-expanded={props.open}
          aria-controls={regionId}
          data-testid="local-host-loading-toggle-details"
          // The card is centred now (see `HostBootCard`), which retires the older `items-stretch` arrangement.
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

/** Live tail of `~/.traycer/bootstrap.log`. */
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
        // align-ok: empty tail matches the <pre> that replaces it.
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
      // align-ok: log output is left-to-right by nature; centring a tail
      // muted-fill-ok: weak tint delimited by its own border-border/60
      className="max-h-72 w-full overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left font-mono text-code-xs text-muted-foreground"
    >
      {props.tail}
    </pre>
  );
}
