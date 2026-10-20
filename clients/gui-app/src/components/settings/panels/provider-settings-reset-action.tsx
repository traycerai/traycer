import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useProvidersSettingsFileReset } from "@/hooks/providers/use-providers-settings-file-reset-mutation";

export const PROVIDER_SETTINGS_RESET_LABEL = "Reset provider settings";

/** Shown above the providers when the host reports its settings file unusable. */
export const PROVIDER_SETTINGS_UNUSABLE_COPY =
  "Traycer can't read this host's provider settings, so every provider is back to its default and changes can't be saved.";

export const PROVIDER_SETTINGS_RESET_TITLE = "Reset provider settings?";

/**
 * The consent the reset asks for: what it does, what stops working, and that
 * nothing is deleted.
 */
export const PROVIDER_SETTINGS_RESET_CONSENT =
  "Traycer will set the unreadable settings file aside and start a new one. Your saved provider choices, and any API key you saved in Traycer, will stop being used: you'll turn providers back on and enter those keys again. Nothing is deleted. The old file stays in the same folder.";

/**
 * "Reset provider settings" and the dialog that asks for consent first.
 *
 * Rendered by the Providers panel only where the host has said the WHOLE
 * settings document is unusable: a `providers.list` read fault, or
 * `providers.settingsFile.status` answering `unreadable`. A single malformed
 * provider row never reaches here - the host does not report it as unusable,
 * and every other provider can still be changed.
 *
 * The caller has already checked the host supports
 * `providers.settingsFile.reset`.
 */
export function ProviderSettingsResetAction(): ReactNode {
  const [open, setOpen] = useState(false);
  const reset = useProvidersSettingsFileReset();
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={reset.isPending}
      >
        {PROVIDER_SETTINGS_RESET_LABEL}
        {reset.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </Button>
      <ConfirmDestructiveDialog
        open={open}
        onOpenChange={setOpen}
        title={PROVIDER_SETTINGS_RESET_TITLE}
        description={PROVIDER_SETTINGS_RESET_CONSENT}
        cascadeSummary={null}
        actionLabel={PROVIDER_SETTINGS_RESET_LABEL}
        isPending={reset.isPending}
        blockedReason={null}
        onConfirm={() => {
          reset.mutate({}, { onSettled: () => setOpen(false) });
        }}
      />
    </>
  );
}
