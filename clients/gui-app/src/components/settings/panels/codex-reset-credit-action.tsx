import { useState, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import type { CodexResetCredit } from "@/components/settings/panels/codex-reset-credit-model";
import { useConsumeRateLimitResetCreditMutation } from "@/hooks/providers/use-consume-rate-limit-reset-credit-mutation";
import {
  formatResetFullDateTime,
  useIsFarReset,
  useResetCountdown,
} from "@/lib/relative-time";

function resetCreditDescription(
  selectedCredit: CodexResetCredit | null,
  expiryCountdown: string | null,
  farExpiry: boolean,
  availableCount: number,
): string {
  if (selectedCredit === null) {
    return "This uses one manual reset on the currently reached Codex usage limit. The reset can't be returned or undone.";
  }
  let expiry = "with no expiry";
  if (selectedCredit.expiresAt !== null) {
    expiry = farExpiry
      ? `expiring ${formatResetFullDateTime(selectedCredit.expiresAt)}`
      : `expiring in ${expiryCountdown ?? "less than a minute"}`;
  }
  const remaining = Math.max(0, availableCount - 1);
  const remainingLabel = remaining === 1 ? "manual reset" : "manual resets";
  return `This uses the reset ${expiry} on the currently reached Codex usage limit. It can't be returned or undone. You'll have ${remaining} ${remainingLabel} left.`;
}

export function CodexResetCreditAction({
  profileId,
  selectedCredit,
  availableCount,
}: {
  readonly profileId: string | null;
  readonly selectedCredit: CodexResetCredit | null;
  readonly availableCount: number;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const mutation = useConsumeRateLimitResetCreditMutation();
  const expiresAt = selectedCredit?.expiresAt ?? null;
  const expiryCountdown = useResetCountdown(expiresAt);
  const farExpiry = useIsFarReset(expiresAt);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={mutation.isPending}
        onClick={() => {
          setIdempotencyKey(crypto.randomUUID());
          setOpen(true);
        }}
      >
        {mutation.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Use reset
      </Button>
      <ConfirmDestructiveDialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setIdempotencyKey(null);
        }}
        title="Use a Codex manual reset?"
        description={resetCreditDescription(
          selectedCredit,
          expiryCountdown,
          farExpiry,
          availableCount,
        )}
        cascadeSummary={null}
        actionLabel="Use reset"
        isPending={mutation.isPending}
        onConfirm={() => {
          if (idempotencyKey === null) return;
          mutation.mutate(
            {
              providerId: "codex",
              profileId,
              idempotencyKey,
              creditId: selectedCredit?.id ?? null,
            },
            {
              onSuccess: () => {
                setIdempotencyKey(null);
                setOpen(false);
              },
            },
          );
        }}
      />
    </>
  );
}
