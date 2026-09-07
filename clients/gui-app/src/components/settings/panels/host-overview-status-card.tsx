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

/** The Overview status card's moving parts - the pieces that differ between a host that can do a thing and one
 * that cannot. */

/** A disabled button that cannot say why is the failure mode this replaces. */
export function HostOverviewActionButton(props: {
  readonly label: string;
  readonly hostName: string;
  readonly variant: "default" | "secondary" | "ghost";
  readonly degrade: OverviewDegradeReason | null;
  readonly pending: boolean;
  readonly busy: boolean;
  readonly onClick: () => void;
  readonly testId: string;
  readonly buttonRef: RefObject<HTMLButtonElement | null> | undefined;
}): ReactNode {
  // Destructured up front, deliberately: `props` carries a ref, and reading any field off it inside the JSX
  // below makes the ref lint rule treat every one of those reads as a possible render-time ref access.
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
          // Named, unlike this card's other spinners: this one is the only evidence that the button a person pressed is
          // still the button doing the work, and `disabled` cannot stand in for it - three different props drive that.
          testId={`${testId}-spinner`}
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
      {/* A disabled button fires no pointer events, so the tooltip needs a live element to hang off - the same
         wrapper the update region uses. */}
      <span className="inline-flex">{button}</span>
    </TooltipWrapper>
  );
}

/** The rename affordance: a pencil against the name, not a word in the verb bar. The `aria-label` is the
 * button's whole accessible name, so it stays the literal words a person would look for. */
export function HostOverviewNameAction(props: {
  readonly hostName: string;
  /** A `host.identity.set` is unresolved; a second editor would race it. */
  readonly pendingWrite: boolean;
  /** The page-wide lifecycle gate: an install, restart, or OS-service write is in flight, so a rename must not
   * dispatch against a host that is swapping versions or shutting down. */
  readonly locked: boolean;
  readonly degrade: OverviewDegradeReason | null;
  readonly loaded: boolean;
  /** The last settled identity read rejected and there is still no name - distinct from "has not answered yet". */
  readonly failed: boolean;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly onEdit: () => void;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
}): ReactNode {
  const { hostName, degrade, buttonRef } = props;
  // These reads do not retry, and focus/reconnect refetches are disabled in production, so nothing short of a
  // remount ever cleared it.
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
      // Opening a disabled editor is the other half of the same focus-loss finding: block the trigger while there is
      // no name data to edit.
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

/* The band is gone rather than fixed in place: one verdict, one affordance, and that affordance is
   `HostBusyForceDeferDialog` (see `host-overview-panel.tsx` and `local-host-restart-flow.tsx`). */

/** `host.update.install` returns the moment the detached swap is started, so this - not that response - is the
 * only thing that can say how it is going. */
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

/** A menu item cannot reliably do that - a disabled item takes no pointer events and the menu owns the focus
 * scope - but it has something better: room for a second line. */
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
  // A degraded item's whole point is the reason rendered under it - and Radix's `disabled` removes the item from
  // arrow-key and typeahead navigation.
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
        {/* The spinner takes the icon's place rather than sitting beside it, so a pending item keeps the label on the
           same x-position as its idle neighbours instead of shunting right while it runs. */}
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

/** It is also not a host RPC and has no degrade reason - it is an account-side selection this shell makes -
 * which is why it sits apart from the capability-gated verbs in the menu and carries only a reachability gate. */
export function HostOverviewHeaderActions(props: {
  readonly hostName: string;
  /** The recovery console can be looking at a machine with no host installed at all, where the only useful verb
   * is Install - a state the Overview cannot reach, since it only renders for a host that answered an RPC. */
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
  /** It lives here rather than beside the inline editor because the editor is now the name itself - there is no
   * chrome around it to hang a third verb on. */
  readonly onResetName: (() => void) | null;
  readonly resetNameDegrade: OverviewDegradeReason | null;
  readonly onRestart: () => void;
  readonly onOpenDoctor: () => void;
  readonly onMakeActive: () => void;
  /** An Activate is already in flight - see `HostScope.isActivating`. */
  readonly activateBusy: boolean;
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
        // A person who expects this to move their work would otherwise watch nothing happen and conclude it is broken.
        <TooltipWrapper
          // The reason rides the disabled state, same as every other unavailable control on this card: a greyed Activate
          // with the switching-scope sentence explains a different decision than the one the user is blocked on.
          label={
            props.connectable
              ? // Not "tabs stay on the host they started on" - the active-host
                // switch still reloads open tabs today (F2/F3/F7), so that
                // promise would be false. This only says what IS true.
                "Switching changes where new work starts."
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
              disabled={!props.connectable || props.activateBusy}
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
            // Same page-wide gate as Restart: opening the sheet mounts `HostDoctorRpcCard`, which dispatches `host.doctor`
            // immediately - another CLI process against a host mid-install or mid-shutdown.
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
          {/* It is genuinely useful in exactly one situation - pasting it into a support report - so it lives where you
             go looking when you already know you want it. */}
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
