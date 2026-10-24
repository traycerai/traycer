import { useState, type ReactNode } from "react";
import {
  CANCEL_LABEL,
  DONE_LABEL,
  INVITE_LABEL,
  inviteDialogLead,
  inviteEmailLabel,
  inviteForbiddenRefusal,
  inviteRoleLabel,
  inviteSeatCopy,
  inviteSentLabel,
  ROLE_LABELS,
  seatLimitRefusal,
} from "@/components/settings/members/copy";
import type {
  MembersInviteOutcome,
  SeatDelta,
  TeamRole,
} from "@/components/settings/members/types";
import { isTeamRole } from "@/components/settings/members/types";
import { EnumSelect } from "@/components/settings/settings-enum-select";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type InviteDialogPhase =
  | { readonly kind: "form"; readonly email: string; readonly role: TeamRole }
  | { readonly kind: "sent"; readonly seatDelta: SeatDelta | null }
  | { readonly kind: "refused"; readonly message: string };

function emailLooksValid(value: string): boolean {
  const trimmed = value.trim();
  const at = trimmed.indexOf("@");
  if (at <= 0) return false;
  const domain = trimmed.slice(at + 1);
  return (
    domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".")
  );
}

function refusalMessage(
  teamName: string,
  outcome: Extract<
    MembersInviteOutcome,
    { outcome: "forbidden" } | { outcome: "seat_limit" }
  >,
): string {
  if (outcome.outcome === "seat_limit") return seatLimitRefusal(teamName);
  return inviteForbiddenRefusal();
}

/**
 * Admin invite: email, role (Editor by default), then the seat sentence
 * from `invite`'s `seatDelta` when present; nothing when null.
 */
export function InviteDialog(props: {
  readonly open: boolean;
  readonly teamName: string;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onInvite: (input: {
    readonly email: string;
    readonly role: TeamRole;
  }) => Promise<MembersInviteOutcome>;
}): ReactNode {
  const [phase, setPhase] = useState<InviteDialogPhase>({
    kind: "form",
    email: "",
    role: "editor",
  });

  const reset = (): void => {
    setPhase({ kind: "form", email: "", role: "editor" });
  };

  const close = (open: boolean): void => {
    if (!open) reset();
    props.onOpenChange(open);
  };

  const submit = (): void => {
    if (phase.kind !== "form") return;
    const email = phase.email.trim();
    if (!emailLooksValid(email)) return;
    void props.onInvite({ email, role: phase.role }).then((outcome) => {
      if (outcome.outcome === "sent") {
        setPhase({ kind: "sent", seatDelta: outcome.seatDelta });
        return;
      }
      setPhase({
        kind: "refused",
        message: refusalMessage(props.teamName, outcome),
      });
    });
  };

  const seatCopy =
    phase.kind === "sent"
      ? inviteSeatCopy(props.teamName, phase.seatDelta)
      : null;

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="members-invite-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {phase.kind === "sent" ? inviteSentLabel() : INVITE_LABEL}
          </DialogTitle>
          <DialogDescription>
            {phase.kind === "form"
              ? inviteDialogLead(props.teamName)
              : inviteSentLabel()}
          </DialogDescription>
        </DialogHeader>
        {phase.kind === "form" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="members-invite-email">{inviteEmailLabel()}</Label>
              <Input
                id="members-invite-email"
                type="email"
                value={phase.email}
                autoComplete="off"
                data-testid="members-invite-email"
                onChange={(event) => {
                  setPhase({
                    kind: "form",
                    email: event.target.value,
                    role: phase.role,
                  });
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{inviteRoleLabel()}</Label>
              <EnumSelect
                labels={ROLE_LABELS}
                value={phase.role}
                isValue={isTeamRole}
                onValueChange={(role) => {
                  setPhase({ kind: "form", email: phase.email, role });
                }}
                ariaLabel={inviteRoleLabel()}
              />
            </div>
          </div>
        ) : null}
        {phase.kind === "sent" && seatCopy !== null ? (
          <p
            className="max-w-[72ch] text-ui-sm"
            data-testid="members-invite-seat-copy"
          >
            {seatCopy}
          </p>
        ) : null}
        {phase.kind === "refused" ? (
          <p
            className="max-w-[72ch] text-ui-sm text-destructive"
            data-testid="members-invite-refusal"
            role="status"
          >
            {phase.message}
          </p>
        ) : null}
        <DialogFooter>
          {phase.kind === "form" ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => close(false)}
              >
                {CANCEL_LABEL}
              </Button>
              <Button
                type="button"
                onClick={submit}
                disabled={props.busy || !emailLooksValid(phase.email)}
                data-testid="members-invite-submit"
              >
                {props.busy ? (
                  <AgentSpinningDots
                    className={undefined}
                    testId="members-invite-busy"
                    variant={undefined}
                    tone="inherit"
                  />
                ) : null}
                {INVITE_LABEL}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              onClick={() => close(false)}
              data-testid="members-invite-done"
            >
              {DONE_LABEL}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
