import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useConsumeRateLimitResetCreditMutation } from "@/hooks/providers/use-consume-rate-limit-reset-credit-mutation";

export function CodexResetCreditAction({
  profileId,
}: {
  readonly profileId: string | null;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const mutation = useConsumeRateLimitResetCreditMutation();

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={mutation.isPending}
        onClick={() => {
          setOpen(true);
        }}
      >
        Use reset
      </Button>
      <ConfirmDestructiveDialog
        open={open}
        onOpenChange={setOpen}
        title="Use a Codex manual reset?"
        description="This uses one manual reset on the currently reached Codex usage limit. The reset can't be returned or undone."
        cascadeSummary={null}
        actionLabel="Use reset"
        isPending={mutation.isPending}
        onConfirm={() => {
          mutation.mutate(
            {
              providerId: "codex",
              profileId,
              idempotencyKey: crypto.randomUUID(),
            },
            {
              onSuccess: () => {
                setOpen(false);
              },
            },
          );
        }}
      />
    </>
  );
}
