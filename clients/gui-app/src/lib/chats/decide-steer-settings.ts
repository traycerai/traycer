import type {
  ChatActiveTurn,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * Decides whether steering a queued prompt into the running turn can fold in silently or must interrupt and restart the turn under new settings.
 */
export type SteerSettingsDecision =
  | { readonly kind: "silent_inject" }
  | {
      readonly kind: "interrupt_restart";
      readonly newSettings: ChatRunSettings;
      readonly changed: ReadonlyArray<string>;
    };

export function decideSteerSettings(
  activeTurn: ChatActiveTurn | null,
  currentSettings: ChatRunSettings | null,
): SteerSettingsDecision {
  if (activeTurn === null || currentSettings === null) {
    return { kind: "silent_inject" };
  }

  const changed: string[] = [];
  if (
    activeTurn.harnessId !== currentSettings.harnessId ||
    activeTurn.model !== currentSettings.model
  ) {
    changed.push("model");
  }
  if (activeTurn.reasoningEffort !== currentSettings.reasoningEffort) {
    changed.push("reasoning effort");
  }
  if (activeTurn.serviceTier !== currentSettings.serviceTier) {
    changed.push("service tier");
  }
  if (activeTurn.profileId !== currentSettings.profileId) {
    changed.push("profile");
  }

  if (changed.length === 0) {
    return { kind: "silent_inject" };
  }

  return {
    kind: "interrupt_restart",
    newSettings: currentSettings,
    changed,
  };
}
