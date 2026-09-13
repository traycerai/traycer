import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import type { TierCandidate } from "@traycer/protocol/host/fallback-policy";
import { harnessDisplayName } from "@/components/session-import/session-import-model";

/**
 * "Claude Code" for a GUI harness, the raw id for anything else.
 *
 * `harnessDisplayName` takes the GUI union, and a stored candidate may name a
 * vendor outside it. Printing the id is the honest fallback: it is what is
 * saved, and inventing a friendly name for a harness this surface cannot
 * describe would be a label with nothing behind it.
 *
 * ## Why this is its own module
 *
 * It lived in `fallback-tier-group-card.tsx` until a second surface needed the
 * same label, and a second implementation of "name a harness" is a second way
 * to name one vendor. Exporting it from the card was the
 * obvious move and is the wrong one: that file exports React components, and
 * `react(only-export-components)` objects to a module that exports both - the
 * same rule that keeps `resetConfirmDescription` unexported in
 * `fallback-danger-zone.tsx`, with its reason recorded there.
 *
 * Not folded into `fallback-profile-labels.ts` either, though that is the
 * neighbouring label module. Two reasons: it answers a different question
 * (which vendor, not which account), and that module imports
 * `useProvidersList`, so importing it for a pure string formatter would drag a
 * hook and a host query into every consumer that only wants to spell a harness
 * id. A `.ts` module with no React import cannot acquire either problem.
 */
export function harnessLabel(harnessId: TierCandidate["harnessId"]): string {
  const parsed = guiHarnessIdSchema.safeParse(harnessId);
  return parsed.success ? harnessDisplayName(parsed.data) : harnessId;
}
