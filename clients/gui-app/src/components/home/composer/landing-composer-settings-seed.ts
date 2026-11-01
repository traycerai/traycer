import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

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
