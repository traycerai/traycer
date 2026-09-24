import { useId, useRef, type ReactNode } from "react";
import { HostRestartSessions } from "@/components/host/host-restart-sessions";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  HOST_QUIT_CANCEL_LABEL,
  HOST_QUIT_REMEMBER_LABEL,
} from "@/lib/host/host-lifecycle-copy";

/** Which button a pending answer came from, so only it shows the spinner. */
export type HostQuitDialogAction = "keep" | "stop" | "cancel";

export interface HostQuitDialogViewProps {
  readonly open: boolean;
  /** Exposed as `data-quit-state` so a test can tell the states apart. */
  readonly stateKind: string;
  readonly title: string;
  readonly description: string;
  /** A second paragraph: the host's own refusal, or an inline failure. */
  readonly detail: string | null;
  readonly countsLine: string | null;
  /** The host whose running agents and terminals are listed; `null` hides it. */
  readonly sessionsHostId: string | null;
  /**
   * Non-null while main stops the host: the body becomes this progress line
   * and every button is disabled until main reports the quit done.
   */
  readonly stoppingLine: string | null;
  /** `null` hides the checkbox (the `→ none` confirm has nothing to remember). */
  readonly remember: {
    readonly checked: boolean;
    readonly onChange: (checked: boolean) => void;
  } | null;
  /** `null` hides Keep (the `→ none` confirm's only choice is Stop). */
  readonly keepLabel: string | null;
  readonly stopLabel: string;
  readonly stopDisabled: boolean;
  /** The answer in flight, if any; every button is disabled while it is. */
  readonly pendingAction: HostQuitDialogAction | null;
  readonly onKeep: () => void;
  readonly onStop: () => void;
  readonly onCancel: () => void;
  /** A listed agent or terminal was opened: cancel and get out of the way. */
  readonly onNavigate: () => void;
}

/**
 * The host quit modal's presentation, shared by the quit prompt and the
 * `→ none` confirm. Same visual family as `HostBusyForceDeferDialog`, with a
 * third action.
 *
 * Keep is the primary action and takes focus when the dialog opens, so Enter
 * keeps the host - the choice that never loses work. Where there is no Keep,
 * Cancel takes focus instead, never Stop.
 */
export function HostQuitDialogView(props: HostQuitDialogViewProps): ReactNode {
  const rememberId = useId();
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const stopping = props.stoppingLine !== null;
  const locked = stopping || props.pendingAction !== null;
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !locked) props.onCancel();
      }}
    >
      <DialogContent
        layout="banded"
        showCloseButton={false}
        className="w-[min(92vw,32rem)] overflow-hidden sm:max-w-lg"
        data-testid="host-quit-dialog"
        data-quit-state={props.stateKind}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (keepRef.current ?? cancelRef.current)?.focus();
        }}
      >
        <div className="flex flex-col gap-1.5 p-5">
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
          {props.detail === null ? null : (
            <p
              className="text-ui-sm leading-relaxed text-muted-foreground"
              data-testid="host-quit-detail"
            >
              {props.detail}
            </p>
          )}
        </div>
        {stopping ? (
          <div
            role="status"
            className="flex items-center gap-2 border-t border-border/60 px-5 py-3 text-ui-sm"
            data-testid="host-quit-stopping"
          >
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
            <span className="min-w-0">{props.stoppingLine}</span>
          </div>
        ) : (
          <>
            {props.sessionsHostId === null ? null : (
              <HostRestartSessions
                hostId={props.sessionsHostId}
                disabled={locked}
                onNavigate={props.onNavigate}
              />
            )}
            {props.countsLine === null ? null : (
              <p
                className="border-t border-border/60 px-5 py-3 text-ui-sm text-muted-foreground"
                data-testid="host-quit-counts"
              >
                {props.countsLine}
              </p>
            )}
            {props.remember === null ? null : (
              <div className="flex items-center gap-2 px-5 pb-4">
                <Checkbox
                  id={rememberId}
                  checked={props.remember.checked}
                  disabled={locked}
                  onCheckedChange={(checked) => {
                    props.remember?.onChange(checked === true);
                  }}
                  data-testid="host-quit-remember"
                />
                <Label htmlFor={rememberId} variant="option">
                  {HOST_QUIT_REMEMBER_LABEL}
                </Label>
              </div>
            )}
          </>
        )}
        <DialogFooter>
          <Button
            ref={cancelRef}
            type="button"
            variant="ghost"
            disabled={locked}
            onClick={props.onCancel}
            data-testid="host-quit-cancel"
          >
            {props.pendingAction === "cancel" ? <PendingDots /> : null}
            {HOST_QUIT_CANCEL_LABEL}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={locked || props.stopDisabled}
            onClick={props.onStop}
            data-testid="host-quit-stop"
          >
            {props.pendingAction === "stop" ? <PendingDots /> : null}
            {props.stopLabel}
          </Button>
          {props.keepLabel === null ? null : (
            <Button
              ref={keepRef}
              type="button"
              variant="default"
              disabled={locked}
              onClick={props.onKeep}
              data-testid="host-quit-keep"
            >
              {props.pendingAction === "keep" ? <PendingDots /> : null}
              {props.keepLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PendingDots(): ReactNode {
  return (
    <AgentSpinningDots
      className={undefined}
      testId={undefined}
      variant={undefined}
    />
  );
}
