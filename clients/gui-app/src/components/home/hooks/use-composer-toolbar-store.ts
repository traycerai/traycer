import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

import type {
  PermissionMode,
  AgentMode,
  HarnessModelSelection,
  ModelOption,
  ProviderId,
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
import { commitSelection } from "@/stores/composer/commit-selection";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
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
      // The recording wrapper is installed via the effect below - never the raw
      // caller callback - so it is the single, always-present write site.
      onSettingsChange: null,
      tuiOnly,
    }),
  );
  // The store's `onSettingsChange` is ALWAYS this recording wrapper, even when
  // the surface passes `onSettingsChange: null` (fork dialogs / add-node), so
  // their edits still populate memory. It records ONLY when the resolved slug is
  // catalog-confirmed (`selectionCatalogConfirmed`, exposed by the store) - the
  // catalog-confirmed write gate - so a seed, a surface reroute (the store
  // suppresses the emit), or an unvalidated/stale remembered slug is never
  // written. `record()` also self-guards an empty model.
  const recordingOnSettingsChange = useCallback(
    (settings: ChatRunSettings) => {
      // Precondition: every store emit site `set()`s the derived state BEFORE
      // invoking `onSettingsChange`, so `getState().selectionCatalogConfirmed`
      // here reflects the very settings being emitted - the write gate does not
      // race the emit.
      if (store.getState().selectionCatalogConfirmed) {
        useComposerHarnessMemoryStore.getState().record(settings);
      }
      onSettingsChange?.(settings);
    },
    [store, onSettingsChange],
  );
  useEffect(() => {
    store.getState().setOnSettingsChange(recordingOnSettingsChange);
  }, [store, recordingOnSettingsChange]);
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
  // Explicit load status for the CURRENT `harnessId`'s models query, threaded to
  // the store so it can tell "loading" from "loaded empty" (the query is keyed
  // on `harnessId`, so `data` resets to undefined during a cross-harness switch
  // until the new harness's models land). Never inferred from `models.length`.
  const modelsLoaded = activityEnabled && modelsQuery.data !== undefined;
  useEffect(() => {
    store.getState().setCatalog({
      harnesses,
      modelsHarnessId: harnessId,
      models,
      modelsLoaded,
      tuiOnly,
    });
  }, [store, harnesses, models, modelsLoaded, harnessId, tuiOnly]);

  const registeredControls = useMemo(() => {
    const actions = store.getState();
    return {
      setReasoning: actions.setReasoning,
      setServiceTier: actions.setServiceTier,
      setPermission: actions.setPermission,
      switchHarness: (harnessId: ProviderId) =>
        commitSelection(store, harnessId, null),
      selectModel: (harnessId: ProviderId, modelSlug: string) =>
        commitSelection(store, harnessId, modelSlug),
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
