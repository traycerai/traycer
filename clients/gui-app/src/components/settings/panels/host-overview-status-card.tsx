import type { ReactNode, RefObject } from "react";
import { AlertTriangle, Info, Pencil } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  describeOverviewDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";

/**
 * The Overview status card's moving parts — the pieces that differ between a
 * host that can do a thing and one that cannot.
 *
 * The card itself is `HostIdentityCard`, shared: the whole point of the
 * restructure is that a local host and a remote host are described by the SAME
 * component reading the SAME RPCs, so anything that would have become an
 * `isLocalMachine` branch in the card had to become an input to it instead.
 */

/**
 * One action, with its reason for being unavailable attached.
 *
 * A disabled button that cannot say why is the failure mode this replaces: an
 * old host and a host with no CLI both produced a greyed-out control, and the
 * remedies are completely different (update the host / install the CLI).
 */
export function HostOverviewActionButton(props: {
  readonly label: string;
  readonly hostName: string;
  readonly variant: "default" | "secondary" | "ghost";
  readonly degrade: OverviewDegradeReason | null;
  readonly pending: boolean;
  /** Non-capability reasons to block the click (another action in flight). */
  readonly busy: boolean;
  readonly onClick: () => void;
  readonly testId: string;
  readonly buttonRef: RefObject<HTMLButtonElement | null> | undefined;
}): ReactNode {
  // Destructured up front, deliberately: `props` carries a ref, and reading any
  // field off it inside the JSX below makes the ref lint rule treat every one of
  // those reads as a possible render-time ref access. The ref itself is only
  // ever handed to `ref=`, which is the one legal thing to do with it here.
  const {
    label,
    hostName,
    variant,
    degrade,
    pending,
    busy,
    onClick,
    testId,
    buttonRef,
  } = props;
  const button = (
    <Button
      ref={buttonRef}
      type="button"
      variant={variant}
      size="sm"
      disabled={degrade !== null || busy || pending}
      onClick={onClick}
      data-testid={testId}
      data-degraded={degrade ?? undefined}
    >
      {pending ? (
        <AgentSpinningDots
          className="mr-2 size-3"
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      {label}
    </Button>
  );
  if (degrade === null) return button;
  return (
    <TooltipWrapper
      label={describeOverviewDegrade(degrade, hostName)}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      {/* A disabled button fires no pointer events, so the tooltip needs a live
          element to hang off — the same wrapper the update region uses. */}
      <span className="inline-flex">{button}</span>
    </TooltipWrapper>
  );
}

/**
 * The rename affordance: a pencil against the name, not a word in the verb bar.
 *
 * Same degrade discipline as the buttons below — `host.identity.set` gates it,
 * and a host that can be read but not written gets a disabled pencil with the
 * reason attached rather than an editor that would call a method the handshake
 * already declined. The `aria-label` is the button's whole accessible name, so
 * it stays the literal words a person would look for.
 */
export function HostOverviewNameAction(props: {
  readonly hostName: string;
  readonly degrade: OverviewDegradeReason | null;
  /** The identity read has answered, so there is a name to edit. */
  readonly loaded: boolean;
  /** The identity read REJECTED — distinct from "has not answered yet". */
  readonly failed: boolean;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly onEdit: () => void;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
}): ReactNode {
  const { hostName, degrade, buttonRef } = props;
  // A FAILED identity read is not a slow one, and conflating them stranded
  // rename outright: a rejected `host.identity.get` left the trigger
  // permanently busy with no error text and nothing to click. These reads do
  // not retry, and focus/reconnect refetches are disabled in production, so
  // nothing short of a remount ever cleared it. The failed read keeps a
  // WORDED button — an icon that means "your name failed to load, press to
  // try again" is not a pictogram anyone owns.
  if (props.failed) {
    return (
      <HostOverviewActionButton
        label="Retry name"
        hostName={hostName}
        variant="ghost"
        degrade={degrade}
        pending={props.retrying}
        busy={false}
        testId="host-overview-retry-identity"
        buttonRef={buttonRef}
        onClick={props.onRetry}
      />
    );
  }
  const button = (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      size="sm"
      className="size-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
      // Opening a disabled editor is the other half of the same focus-loss
      // finding: block the TRIGGER while there is no name data to edit.
      disabled={degrade !== null || !props.loaded}
      onClick={props.onEdit}
      aria-label="Edit name"
      data-testid="host-overview-edit-name"
      data-degraded={degrade ?? undefined}
    >
      <Pencil className="size-3.5" />
    </Button>
  );
  return (
    <TooltipWrapper
      label={
        degrade === null
          ? `Rename ${hostName}`
          : describeOverviewDegrade(degrade, hostName)
      }
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      {/* A disabled button fires no pointer events, so the tooltip needs a live
          element to hang off. */}
      <span className="inline-flex">{button}</span>
    </TooltipWrapper>
  );
}

/**
 * The host refused to restart because it is busy.
 *
 * Deliberately not a toast and not an error: the host closed session admission,
 * found work in flight, reopened it, and told us the count. Nothing failed and
 * nothing needs reporting — the honest affordance is to say what it is waiting
 * on and let the person decide whether to try again.
 */
export function HostRestartBusyNotice(props: {
  readonly busySessionCount: number;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  readonly retryPending: boolean;
}): ReactNode {
  const { busySessionCount } = props;
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-amber-700/30 bg-amber-900/10 px-5 py-3 text-ui-sm"
      data-testid="host-overview-restart-busy"
    >
      <span className="flex min-w-0 flex-1 items-start gap-2 text-amber-200">
        <AlertTriangle className="mt-px size-4 shrink-0" aria-hidden />
        <span>
          Not restarted —{" "}
          {busySessionCount === 1
            ? "1 session is"
            : `${busySessionCount} sessions are`}{" "}
          still working. Nothing was interrupted; try again when they finish.
        </span>
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.retryPending}
        onClick={props.onRetry}
        data-testid="host-overview-restart-busy-retry"
      >
        Try again
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={props.onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/**
 * A host update in flight, as the HOST reports it on `host.status`.
 *
 * `host.update.install` returns the moment the detached swap is started, so
 * this — not that response — is the only thing that can say how it is going.
 */
export function HostOverviewUpdateProgress(props: {
  readonly state: "updating" | "failed";
  readonly error: string | null;
}): ReactNode {
  const failed = props.state === "failed";
  return (
    <div
      className={
        failed
          ? "flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-5 py-3 text-ui-sm text-destructive"
          : "flex items-center gap-2 border-b border-border/40 bg-muted/20 px-5 py-3 text-ui-sm text-muted-foreground"
      }
      data-testid="host-overview-update-progress"
      data-state={props.state}
    >
      {failed ? (
        <AlertTriangle className="mt-px size-4 shrink-0" aria-hidden />
      ) : (
        <AgentSpinningDots
          className="size-3"
          testId={undefined}
          variant={undefined}
        />
      )}
      <span className="min-w-0 flex-1">
        {failed
          ? (props.error ?? "The last update attempt failed on this host.")
          : "Updating this host…"}
      </span>
    </div>
  );
}

/** A quiet, non-blocking explanation under a control that has degraded. */
export function HostOverviewNotice(props: {
  readonly children: ReactNode;
  readonly testId: string;
}): ReactNode {
  return (
    <div
      className="flex items-start gap-2 px-5 py-2.5 text-ui-xs text-muted-foreground"
      data-testid={props.testId}
    >
      <Info className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="max-w-[68ch]">{props.children}</span>
    </div>
  );
}

/**
 * The status card's verb bar: Restart, Run doctor, and — only when this window
 * is pointed somewhere else — Use in this window.
 *
 * One component so the cluster's per-button degrade discipline lives in one
 * place — each control asks its OWN method, and none of them is disabled by
 * another's absence. That is the difference this page was restructured for: a
 * host too old for `host.restart` still gets a working doctor and rename.
 *
 * The window binding joined this bar from the "Active for this window" row it
 * used to own. It is not a host RPC and has no degrade reason — it is an
 * account-side selection this shell makes — so it sits apart from the two
 * capability-gated verbs and carries its own reachability gate.
 */
export function HostOverviewActions(props: {
  readonly hostName: string;
  readonly restartDegrade: OverviewDegradeReason | null;
  readonly doctorDegrade: OverviewDegradeReason | null;
  readonly restartPending: boolean;
  /** Another Overview mutation holds the page. */
  readonly anyPending: boolean;
  /** This window already starts new work here, so there is nothing to bind. */
  readonly isActive: boolean;
  /** A host with no dialable route cannot become this window's host. */
  readonly connectable: boolean;
  readonly onRestart: () => void;
  readonly onOpenDoctor: () => void;
  readonly onMakeActive: () => void;
}): ReactNode {
  const { hostName } = props;
  return (
    <>
      <HostOverviewActionButton
        label="Restart"
        hostName={hostName}
        variant="secondary"
        degrade={props.restartDegrade}
        pending={props.restartPending}
        busy={props.anyPending}
        testId="host-overview-restart"
        buttonRef={undefined}
        onClick={props.onRestart}
      />
      <HostOverviewActionButton
        label="Run doctor"
        hostName={hostName}
        variant="secondary"
        degrade={props.doctorDegrade}
        pending={false}
        busy={false}
        testId="host-overview-run-doctor"
        buttonRef={undefined}
        onClick={props.onOpenDoctor}
      />
      {props.isActive ? null : (
        // The asymmetry has to be said out loud somewhere, and the row that
        // used to say it is gone. A person who expects this to move their work
        // would otherwise watch nothing happen and conclude it is broken — so
        // the sentence rides the control it describes, where it is read at the
        // moment of deciding rather than skimmed past on load.
        <TooltipWrapper
          label="Switching changes where new work starts. Tabs you already have open stay on the host they started on."
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <span className="inline-flex">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!props.connectable}
              onClick={props.onMakeActive}
              data-testid="host-make-active"
            >
              Use in this window
            </Button>
          </span>
        </TooltipWrapper>
      )}
    </>
  );
}
