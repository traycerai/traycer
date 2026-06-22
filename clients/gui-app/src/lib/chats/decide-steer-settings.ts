import type {
  ChatActiveTurn,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * Decides whether steering a queued prompt into the running turn can fold in
 * silently or must interrupt and restart the turn under new settings.
 *
 * The comparison set is kept in lockstep with the host's
 * `queuedSettingsMatchActiveExecution`: harness, model, reasoning effort,
 * service tier, and agent mode are baked into turn/thread start, so changing any
 * of them can't apply to a turn already in flight. permissionMode is excluded -
 * it applies softly to the next turn, so a permission-only change still injects
 * at a safe point. The host derives provider-session fork policy from the
 * accepted settings; this function is renderer-only confirmation policy.
 *
 * `changed` lists human-readable labels for the differing settings, for the
 * confirm dialog copy.
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
  const agentModeChanged = activeTurn.agentMode !== currentSettings.agentMode;
  if (agentModeChanged) {
    changed.push("agent mode");
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
