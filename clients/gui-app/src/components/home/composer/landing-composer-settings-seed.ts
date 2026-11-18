import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { pickedRunSettings } from "@/lib/sandboxes/pending-sandbox-send";
import type { ComposerToolbarState } from "@/stores/composer/composer-toolbar-store";

export function landingComposerSettingsSeedForDraft(
  draftId: string | null,
  draftSettings: ChatRunSettings | null,
  globalLastRunSettings: ChatRunSettings | null,
): ChatRunSettings | null {
  // A draft with no settings was edited before its host resolved, so it was
  // never seeded and has nothing of its own to show.
  if (draftId !== null && draftSettings !== null) return draftSettings;
  return globalLastRunSettings === null
    ? null
    : { ...globalLastRunSettings, ultracode: false };
}

/**
 * What a draft minted now starts from: the host's last-run settings, or the
 * pick shown when those settings may not be it - a stage's kept pick, or an
 * account a person chose before the draft existed. A pick with no model yet
 * cannot be stored: the draft starts as the composer was seeded, and the pick
 * follows once its model resolves (`keptPickUnwritten`, or the pick's emit).
 */
export function landingMintedDraftSettings(
  toolbar: ComposerToolbarState,
  lastRunSettings: ChatRunSettings | null,
): ChatRunSettings | null {
  if (toolbar.sandboxRunTarget !== "staged" && !toolbar.accountChosen) {
    return lastRunSettings;
  }
  const picked = pickedRunSettings(toolbar);
  return picked.model.length > 0
    ? picked
    : landingComposerSettingsSeedForDraft(null, null, lastRunSettings);
}
