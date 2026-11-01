import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { pickedRunSettings } from "@/lib/sandboxes/pending-sandbox-send";
import type { ComposerToolbarState } from "@/stores/composer/composer-toolbar-store";

export function landingComposerSettingsSeedForDraft(
  draftId: string | null,
  draftSettings: ChatRunSettings | null,
  globalLastRunSettings: ChatRunSettings | null,
): ChatRunSettings | null {
  if (draftId !== null) return draftSettings;
  return globalLastRunSettings === null
    ? null
    : { ...globalLastRunSettings, ultracode: false };
}

/**
 * What a draft minted now starts from: the host's last-run settings, or under
 * a stage the pick that stage keeps, which those settings may not be. A kept
 * pick with no model yet cannot be stored: the draft starts as the composer was
 * seeded, and the pick follows once its model resolves (`keptPickUnwritten`).
 */
export function landingMintedDraftSettings(
  toolbar: ComposerToolbarState,
  lastRunSettings: ChatRunSettings | null,
): ChatRunSettings | null {
  if (toolbar.sandboxRunTarget !== "staged") return lastRunSettings;
  const picked = pickedRunSettings(toolbar);
  return picked.model.length > 0
    ? picked
    : landingComposerSettingsSeedForDraft(null, null, lastRunSettings);
}
