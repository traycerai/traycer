import type { ReactNode } from "react";

/**
 * The shared "nothing to show here" card for a provider settings tab.
 *
 * Used both when a provider simply lacks a capability (`providers-settings-
 * panel.tsx`'s per-tab switch) and when a capability exists but the SELECTED
 * PROFILE outruns what the host negotiated (`provider-model-providers-tab.tsx`,
 * W3-T5) - one visual shape for "this tab has nothing to show", regardless of
 * which of those two facts caused it.
 */
export function ProviderTabPlaceholder({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 p-4">
      <div className="text-ui-sm font-medium text-foreground">{title}</div>
      <p className="text-ui-xs text-muted-foreground">{description}</p>
    </div>
  );
}
