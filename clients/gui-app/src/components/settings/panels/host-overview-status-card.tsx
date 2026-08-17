import type { ReactNode, RefObject } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Info,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Stethoscope,
  Undo2,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
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
  /** A `host.identity.set` is unresolved; a second editor would race it. */
  readonly pendingWrite: boolean;
  /**
   * The page-wide lifecycle gate: an install, restart, or OS-service write is
   * in flight, so a rename must not dispatch against a host that is swapping
   * versions or shutting down. Disables the trigger WITHOUT the pending
   * spinner — only `pendingWrite` claims an identity write is running.
   */
  readonly locked: boolean;
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
      // finding: block the TRIGGER while there is no name data to edit - and
      // while a write is still settling, since the editor closes before the
      // settle and a second editor would race it.
      disabled={
        degrade !== null || !props.loaded || props.pendingWrite || props.locked
      }
      onClick={props.onEdit}
      aria-label="Edit name"
      data-testid="host-overview-edit-name"
      data-degraded={degrade ?? undefined}
    >
      {props.pendingWrite ? (
        <AgentSpinningDots
          className="size-3.5"
          testId={undefined}
          variant={undefined}
        />
      ) : (
        <Pencil className="size-3.5" />
      )}
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

/*
 * There is deliberately no busy-restart NOTICE here.
 *
 * A `host.restart` busy verdict used to render as an amber band on this card,
 * with Try again / Force restart / Dismiss inline. Its Force button dispatched
 * the bridge respawn on the FIRST press — so the same verdict was strictly more
 * destructive answered from Settings than from the Help menu, which has always
 * put an explicit force/defer confirm between the offer and the kill. The band
 * is gone rather than fixed in place: one verdict, one affordance, and that
 * affordance is `HostBusyForceDeferDialog` (see `host-overview-panel.tsx` and
 * `local-host-restart-flow.tsx`). Re-adding an inline force control here would
 * put the two surfaces back out of step.
 */

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
          : "flex items-center gap-2 border-b border-border/40 bg-foreground/3 px-5 py-3 text-ui-sm text-muted-foreground"
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
 * One maintenance verb, as a menu item that can say why it is unavailable.
 *
 * The footer verb bar these came from could hang a tooltip off a disabled
 * button. A menu item cannot reliably do that — a disabled item takes no
 * pointer events and the menu owns the focus scope — but it has something
 * better: room for a second line. So the degrade reason is RENDERED under the
 * label rather than hidden behind a hover, which is strictly more legible than
 * what it replaces. The per-item discipline is unchanged: each asks its OWN
 * method, and none is disabled by another's absence.
 */
function HostOverviewMenuAction(props: {
  readonly label: string;
  readonly hostName: string;
  readonly icon: ReactNode;
  readonly degrade: OverviewDegradeReason | null;
  readonly pending: boolean;
  /** Another Overview mutation holds the page. */
  readonly busy: boolean;
  readonly onSelect: () => void;
  readonly testId: string;
}): ReactNode {
  const { degrade, hostName } = props;
  const degraded = degrade !== null;
  // Two inert states, two mechanisms. `busy`/`pending` carry no explanation,
  // so hard `disabled` is honest. A DEGRADED item's whole point is the reason
  // rendered under it — and Radix's `disabled` removes the item from arrow-key
  // and typeahead navigation, making the explanation unreachable to exactly
  // the users who cannot skim it. `aria-disabled` + a swallowed select keeps
  // it announced, focusable, and inert; preventing default also keeps the
  // menu open so the reason can actually be read.
  return (
    <DropdownMenuItem
      disabled={props.busy || props.pending}
      aria-disabled={degraded || props.busy || props.pending ? true : undefined}
      onSelect={(event) => {
        if (degraded) {
          event.preventDefault();
          return;
        }
        props.onSelect();
      }}
      data-testid={props.testId}
      data-degraded={degrade ?? undefined}
      className={cn(
        "flex-col items-start gap-0.5 py-1.5",
        degraded && "text-muted-foreground",
      )}
    >
      <span className="flex items-center gap-2">
        {/* The spinner takes the icon's place rather than sitting beside it, so
            a pending item keeps the label on the same x-position as its idle
            neighbours instead of shunting right while it runs. */}
        {props.pending ? (
          <AgentSpinningDots
            className="size-3.5"
            testId={undefined}
            variant={undefined}
          />
        ) : (
          props.icon
        )}
        {props.label}
      </span>
      {degrade === null ? null : (
        // Indented past the icon: a reason that starts under the glyph reads as
        // a separate row rather than as this item's own subtitle.
        <span className="max-w-[36ch] pl-5.5 text-ui-xs text-muted-foreground">
          {describeOverviewDegrade(degrade, hostName)}
        </span>
      )}
    </DropdownMenuItem>
  );
}

/**
 * The card header's right-hand cluster: the window binding, and everything
 * else behind a `⋯`.
 *
 * This replaces a full-width footer strip. That strip existed because an
 * earlier pass put three WORDED buttons opposite the name and they wrapped into
 * a ragged two-column block at narrow settings widths — so the fix here is not
 * to move the same cluster back, it is to make it narrow enough to belong
 * there: one control plus an icon trigger.
 *
 * The window binding is the one thing that stays inline, and it occupies a
 * SINGLE slot in both states: `Make active in this window` becomes `Active in
 * this window`. Two things make that legible, and both were missing before.
 * The slot — previously the state was a tag beside the name and the verb was a
 * button in the footer, so nothing connected them. And the WORD: the verb used
 * to be "Use in this window" while the state said "Active", which named one
 * binding twice and left it to the reader to guess they were the same thing.
 * One root word, one place. It is also not a host RPC and has no degrade
 * reason — it is an
 * account-side selection this shell makes — which is why it sits apart from
 * the capability-gated verbs in the menu and carries only a reachability gate.
 */
export function HostOverviewHeaderActions(props: {
  readonly hostName: string;
  /**
   * A caller-owned control rendered BEFORE the window binding, or `null`.
   *
   * The one action the two callers do not share. The recovery console can be
   * looking at a machine with no host installed at all, where the only useful
   * verb is Install — a state the Overview cannot reach, since it only renders
   * for a host that answered an RPC. Rather than teach this cluster about
   * installation, the console hands in the button it already owns.
   */
  readonly primaryAction: ReactNode | null;
  readonly restartDegrade: OverviewDegradeReason | null;
  readonly doctorDegrade: OverviewDegradeReason | null;
  readonly restartPending: boolean;
  /** Another Overview mutation holds the page. */
  readonly anyPending: boolean;
  /** This window already starts new work here, so there is nothing to bind. */
  readonly isActive: boolean;
  /** A host with no dialable route cannot become this window's host. */
  readonly connectable: boolean;
  /**
   * Clearing a custom name is the same write as saving one, with `null`. It
   * lives here rather than beside the inline editor because the editor is now
   * the name itself — there is no chrome around it to hang a third verb on.
   * `null` when the host carries no custom name, so there is nothing to clear.
   */
  readonly onResetName: (() => void) | null;
  readonly resetNameDegrade: OverviewDegradeReason | null;
  readonly onRestart: () => void;
  readonly onOpenDoctor: () => void;
  readonly onMakeActive: () => void;
  readonly onCopyHostId: () => void;
}): ReactNode {
  const { hostName } = props;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {props.primaryAction}
      {props.isActive ? (
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 font-medium text-ui-xs text-primary"
          data-testid="host-active-in-window"
        >
          <Check className="size-3.5" aria-hidden />
          Active
        </span>
      ) : (
        // The asymmetry has to be said out loud somewhere, and the row that
        // used to say it is gone. A person who expects this to move their work
        // would otherwise watch nothing happen and conclude it is broken — so
        // the sentence rides the control it describes, where it is read at the
        // moment of deciding rather than skimmed past on load.
        <TooltipWrapper
          // The reason rides the disabled state, same as every other
          // unavailable control on this card: a greyed Activate with the
          // switching-scope sentence explains a DIFFERENT decision than the
          // one the user is blocked on.
          label={
            props.connectable
              ? "Switching changes where new work starts. Tabs you already have open stay on the host they started on."
              : `${hostName} has no dialable route from this window, so it can't become this window's host.`
          }
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
              Activate
            </Button>
          </span>
        </TooltipWrapper>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
            aria-label={`More actions for ${hostName}`}
            data-testid="host-overview-menu"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <HostOverviewMenuAction
            label="Restart"
            hostName={hostName}
            icon={<RotateCcw className="size-3.5" aria-hidden />}
            degrade={props.restartDegrade}
            pending={props.restartPending}
            busy={props.anyPending}
            testId="host-overview-restart"
            onSelect={props.onRestart}
          />
          <HostOverviewMenuAction
            label="Run doctor"
            hostName={hostName}
            icon={<Stethoscope className="size-3.5" aria-hidden />}
            degrade={props.doctorDegrade}
            pending={false}
            // Same page-wide gate as Restart: opening the sheet mounts
            // `HostDoctorRpcCard`, which dispatches `host.doctor` immediately —
            // another CLI process against a host mid-install or mid-shutdown.
            busy={props.anyPending}
            testId="host-overview-run-doctor"
            onSelect={props.onOpenDoctor}
          />
          {props.onResetName === null ? null : (
            <HostOverviewMenuAction
              label="Reset name to default"
              hostName={hostName}
              icon={<Undo2 className="size-3.5" aria-hidden />}
              degrade={props.resetNameDegrade}
              pending={false}
              busy={props.anyPending}
              testId="host-overview-reset-name"
              onSelect={props.onResetName}
            />
          )}
          <DropdownMenuSeparator />
          {/* The host id earned a full-width footer row it did not deserve:
              one opaque uuid nobody reads, permanently occupying a band on a
              card whose other bands are all actionable. It is genuinely useful
              in exactly one situation — pasting it into a support report — so
              it lives where you go looking when you already know you want it. */}
          <DropdownMenuItem
            onSelect={props.onCopyHostId}
            data-testid="host-overview-copy-host-id"
          >
            <Copy className="size-3.5" aria-hidden />
            Copy host ID
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
