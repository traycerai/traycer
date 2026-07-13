import { useState, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useConsumeRateLimitResetCreditMutation } from "@/hooks/providers/use-consume-rate-limit-reset-credit-mutation";

export function CodexResetCreditAction({
  profileId,
}: {
  readonly profileId: string | null;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const mutation = useConsumeRateLimitResetCreditMutation();

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
        description="This uses one manual reset on the currently reached Codex usage limit. The reset can't be returned or undone."
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
