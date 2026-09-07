import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  isShellOutputPanelReplacement,
  type ShellOutputAvailability,
  type ShellOutputBannerAvailability,
  type ShellOutputPanelAvailability,
} from "@/lib/managed-commands/shell-output-availability";

/** Every non-`available` state, so a caller can only ever ask this component to say something - "the log is
 * fine" is not a notice. */
export type ShellOutputNoticeAvailability = Exclude<
  ShellOutputAvailability,
  { kind: "available" }
>;

export interface ShellOutputAvailabilityNoticeProps {
  readonly availability: ShellOutputNoticeAvailability;
  /** `null` on a surface with no tab of its own, which only ever shows the connection strip anyway. */
  readonly onClose: (() => void) | null;
  /** `null` where no stream session exists yet to reopen (the host gate, before a session is created). */
  readonly onReopen: (() => void) | null;
  readonly className: string | undefined;
  readonly testId: string;
}

/** Three shapes, decided by the state rather than by the caller: - a full-panel replacement, centred, for the
 * states under which there is no timeline to show. */
export function ShellOutputAvailabilityNotice(
  props: ShellOutputAvailabilityNoticeProps,
): ReactNode {
  const { availability } = props;
  if (isShellOutputPanelReplacement(availability)) {
    return (
      <PanelNotice
        availability={availability}
        onClose={props.onClose}
        className={props.className}
        testId={props.testId}
      />
    );
  }
  if (availability.kind === "empty") {
    return (
      <p
        className={cn(
          "py-2 text-center text-muted-foreground",
          props.className,
        )}
        data-testid={props.testId}
        data-availability="empty"
      >
        No output yet.
      </p>
    );
  }
  return (
    <BannerNotice
      availability={availability}
      onReopen={props.onReopen}
      className={props.className}
      testId={props.testId}
    />
  );
}

/** Muted throughout: none of these is urgent - the shell is gone, or the host is old, or the machinery is still
 * starting - and shouting would only make a person look for a fire that is not there. */
function PanelNotice(props: {
  readonly availability: ShellOutputPanelAvailability;
  readonly onClose: (() => void) | null;
  readonly className: string | undefined;
  readonly testId: string;
}): ReactNode {
  const { availability } = props;
  const busy = availability.kind === "bootstrapping";
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground",
        props.className,
      )}
      data-testid={props.testId}
      data-availability={availability.kind}
      data-phase={
        availability.kind === "bootstrapping" ? availability.phase : undefined
      }
      data-cause={availability.kind === "gone" ? availability.cause : undefined}
      role="status"
      aria-busy={busy}
    >
      {busy ? (
        <AgentSpinningDots
          className="text-muted-foreground"
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      <p className="max-w-md">{panelSentence(availability)}</p>
      {offersClose(availability) && props.onClose !== null ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onClose}
        >
          Close tab
        </Button>
      ) : null}
    </div>
  );
}

function panelSentence(availability: ShellOutputPanelAvailability): ReactNode {
  switch (availability.kind) {
    case "bootstrapping":
      return bootstrappingPhrase(availability.phase);
    case "unsupported-host":
      return "This host is too old to show shells.";
    case "unreachable-host":
      return (
        <>
          Host &quot;{availability.hostLabel}&quot; is unreachable, so this
          output cannot be read. The shell and its log are kept on that host.
        </>
      );
    // One sentence, no hedge about "what is shown below": nothing is shown
    // below. The history went with the shell.
    case "gone":
      return availability.cause === "deleted"
        ? "This shell was deleted."
        : // Compatible with the wire's deliberate ambiguity: the host refuses
          // a deleted id and a never-existed one identically, and this says no
          // more than that refusal does.
          "This shell is no longer on this host.";
    case "unauthorized":
      return "You no longer have access to this epic's shells.";
  }
}

/** A word under them says which wait this is - the directory, the host process, or the stream - because they
 * end for different reasons and a person staring at one deserves to know which machinery they are waiting on. */
function bootstrappingPhrase(
  phase: Extract<ShellOutputAvailability, { kind: "bootstrapping" }>["phase"],
): string {
  switch (phase) {
    case "checking-host":
      return "Checking host…";
    // Same wording as the chat's own host-starting banner: same state, same
    // words, so nobody reads a second phrasing as a second problem.
    case "starting-host":
      return "Waiting for the host to start…";
    case "opening-stream":
      return "Opening stream…";
    case "connecting":
      return "Connecting…";
  }
}

/** A bootstrapping panel clears on its own; an old host is not the tab's fault - the tab strip closes it as
 * ever. */
function offersClose(availability: ShellOutputPanelAvailability): boolean {
  switch (availability.kind) {
    case "unreachable-host":
    case "gone":
    case "unauthorized":
      return true;
    case "bootstrapping":
    case "unsupported-host":
      return false;
  }
}

/** The strip over a timeline that stays readable. */
function BannerNotice(props: {
  readonly availability: ShellOutputBannerAvailability;
  readonly onReopen: (() => void) | null;
  readonly className: string | undefined;
  readonly testId: string;
}): ReactNode {
  const { availability } = props;
  if (availability.kind === "stale") {
    return (
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 px-2 py-1 text-ui-xs text-muted-foreground",
          props.className,
        )}
        data-testid={props.testId}
        data-availability="stale"
        role="status"
        aria-busy
      >
        <AgentSpinningDots
          className="shrink-0 text-muted-foreground/70"
          testId={undefined}
          variant={undefined}
        />
        <span>Reconnecting…</span>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 bg-warning/10 px-2 py-1 text-ui-xs text-warning-foreground",
        props.className,
      )}
      data-testid={props.testId}
      data-availability="stream-error"
      role="status"
    >
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 wrap-anywhere">
        The output stream failed.{" "}
        {/* The host's own account of why, dimmed rather than hidden: it is what a person pastes into a report, not what
           they read first, but a truncated reason is no reason at all. */}
        <span
          className="text-warning-foreground/70"
          data-testid={`${props.testId}-reason`}
        >
          {availability.message}
        </span>
      </span>
      {props.onReopen === null ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={props.onReopen}
        >
          Retry
        </Button>
      )}
    </div>
  );
}
