import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { FALLBACK_SETTINGS_SECTION_ID } from "@/lib/settings-sections";

/**
 * Providers ▸ Profiles & Limits ▸ the row that points at Settings ▸ Fallback.
 *
 * Profiles & Limits is where someone goes when a provider has stopped working
 * for them - a limit hit, an account signed out - so it is where the question
 * "can it just carry on somewhere else?" actually gets asked. Fallback is a
 * host-wide policy and has no place being configured per provider, so this is
 * a pointer rather than a control.
 *
 * ## Why it reads no state
 *
 * It would be easy to print whether fallback is on, and that is exactly what it
 * must not do. The master toggle would then exist in two places, and during a
 * save the two would disagree - the panel showing the optimistic draft, this
 * row showing whatever its own query last returned. A second readout of a
 * setting is a second thing that can be wrong, on a tab that has no other
 * reason to read the policy at all.
 *
 * Ungated on purpose. Fallback covers a signed-out account and a billing
 * failure as well as a limit, so it is relevant on this tab for every provider,
 * not only the ones that report usage.
 */
export function FallbackCrossLinkRow(): ReactNode {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-5 py-4">
      <p className="max-w-[68ch] text-ui-sm text-muted-foreground">
        When a turn stops on a provider error - a limit, an outage, a billing
        problem, a signed-out account - Traycer can carry the chat on to another
        account or an equivalent model instead of ending it.
      </p>
      <Button
        type="button"
        variant="link"
        className="mt-1 h-auto p-0 text-ui-sm"
        onClick={() => {
          navigateToSettingsSection(FALLBACK_SETTINGS_SECTION_ID);
        }}
      >
        Automatic fallback
        <ArrowRight className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}
