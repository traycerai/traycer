import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

import type {
  PermissionMode,
  AgentMode,
  HarnessModelSelection,
  ModelOption,
  ReasoningLevel,
  ServiceTier,
} from "@/components/home/data/landing-options";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
  type ComposerToolbarValues,
} from "@/stores/composer/composer-toolbar-store";
import {
  useGuiHarnessesQuery,
  useGuiHarnessModelsQuery,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useRegisterFocusedComposerControls } from "@/hooks/command-palette/use-register-composer-controls";
import type { FocusedComposerKind } from "@/lib/commands/types";
import {
  permissionFromChatRunSettings,
  agentModeFromChatRunSettings,
  reasoningFromChatRunSettings,
  selectionFromChatRunSettings,
  serviceTierFromChatRunSettings,
} from "@/lib/composer/chat-run-settings";

const EMPTY_MODELS: ReadonlyArray<ModelOption> = [];

/**
 * Creates this composer's private toolbar store (see
 * `createComposerToolbarStore` for the state model) and keeps it synchronized
 * with its external inputs:
 *
 * - settings-store defaults / the persisted `settingsSeed` (re-seeds when the
 *   seed identity changes);
 * - the harness + model catalog queries, gated on the surrounding
 *   `SurfaceActivityContext`;
 * - the latest `onSettingsChange` callback.
 *
 * When `registerAs !== null` (and the surface is active), the store's setters
 * are registered with the focused-composer-controls registry so the command
 * palette's "Switch model" / "Switch provider" items dispatch against this
 * composer.
 *
 * Returns the store itself: toolbar leaves subscribe to slices, submit paths
 * read `store.getState()`.
 */
export function useComposerToolbarStore(
  registerAs: FocusedComposerKind | null,
  settingsSeed: ChatRunSettings | null,
  onSettingsChange: ((settings: ChatRunSettings) => void) | null,
  tuiOnly: boolean,
): ComposerToolbarStore {
  const activityEnabled = useSurfaceActivity();
  const defaultPermission = useSettingsStore((s) => s.defaultPermission);
  const defaultSelection = useSettingsStore((s) => s.defaultSelection);
  const defaultReasoning = useSettingsStore((s) => s.defaultReasoning);
  const defaultServiceTier = useSettingsStore((s) => s.defaultServiceTier);
  const defaultAgentMode = useSettingsStore((s) => s.defaultAgentMode);
  const seedKey = chatRunSettingsSeedKey(settingsSeed);
  const seededValues = useMemo(
    () =>
      valuesFromSettingsSeed(settingsSeed, {
        permission: defaultPermission,
        selection: defaultSelection,
        reasoning: defaultReasoning,
        serviceTier: defaultServiceTier,
        agentMode: defaultAgentMode,
      }),
    [
      defaultPermission,
      defaultAgentMode,
      defaultReasoning,
      defaultServiceTier,
      defaultSelection,
      settingsSeed,
    ],
  );
  const [store] = useState(() =>
    createComposerToolbarStore({
      seedKey,
      values: seededValues,
      onSettingsChange,
      tuiOnly,
    }),
  );
  useEffect(() => {
    store.getState().setOnSettingsChange(onSettingsChange);
  }, [store, onSettingsChange]);
  // Re-seed when the seed identity changes (applySeed no-ops on a matching
  // key, so default-value churn never clobbers user edits).
  useEffect(() => {
    store.getState().applySeed(seedKey, seededValues);
  }, [store, seedKey, seededValues]);

  // Feed the catalog. The models query follows the store's RESOLVED harness
  // (availability rerouting included); `modelsHarnessId` rides along so a
  // stale response can never resolve a slug for the wrong harness.
  const harnessId = useStore(store, (s) => s.selection.harnessId);
  const harnessesQuery = useGuiHarnessesQuery({
    enabled: activityEnabled,
    subscribed: activityEnabled,
  });
  const modelsQuery = useGuiHarnessModelsQuery(harnessId, null, {
    enabled: activityEnabled,
    subscribed: activityEnabled,
  });
  const harnesses = activityEnabled
    ? harnessesQuery.data?.harnesses
    : undefined;
  const models = activityEnabled
    ? (modelsQuery.data?.models ?? EMPTY_MODELS)
    : EMPTY_MODELS;
  useEffect(() => {
    store.getState().setCatalog({
      harnesses,
      modelsHarnessId: harnessId,
      models,
      tuiOnly,
    });
  }, [store, harnesses, models, harnessId, tuiOnly]);

  const registeredControls = useMemo(() => {
    const actions = store.getState();
    return {
      setSelection: actions.setSelection,
      setReasoning: actions.setReasoning,
      setServiceTier: actions.setServiceTier,
      setPermission: actions.setPermission,
    };
  }, [store]);
  useRegisterFocusedComposerControls(
    activityEnabled ? registerAs : null,
    registeredControls,
  );

  return store;
}

interface ComposerToolbarDefaults {
  readonly permission: PermissionMode;
  readonly selection: HarnessModelSelection;
  readonly reasoning: ReasoningLevel;
  readonly serviceTier: ServiceTier;
  readonly agentMode: AgentMode;
}

function chatRunSettingsSeedKey(settingsSeed: ChatRunSettings | null): string {
  if (settingsSeed === null) return "default";
  return [
    settingsSeed.harnessId,
    settingsSeed.model,
    settingsSeed.permissionMode,
    settingsSeed.reasoningEffort ?? "",
    settingsSeed.serviceTier ?? "",
    settingsSeed.agentMode,
  ].join("\u0000");
}

function valuesFromSettingsSeed(
  settingsSeed: ChatRunSettings | null,
  defaults: ComposerToolbarDefaults,
): ComposerToolbarValues {
  if (settingsSeed === null) return defaults;
  return {
    permission: permissionFromChatRunSettings(settingsSeed),
    selection: selectionFromChatRunSettings(settingsSeed),
    reasoning: reasoningFromChatRunSettings(settingsSeed),
    serviceTier: serviceTierFromChatRunSettings(settingsSeed),
    agentMode: agentModeFromChatRunSettings(settingsSeed),
  };
}
