import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useStore } from "zustand";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@/lib/host";

import type {
  PermissionMode,
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
  useGuiHarnessesQueryForClient,
  useGuiHarnessModelsQueryForClient,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useRegisterFocusedComposerControls } from "@/hooks/command-palette/use-register-composer-controls";
import { useResolvedSeededProfileId } from "@/hooks/providers/use-resolved-seeded-profile-id";
import type { FocusedComposerKind } from "@/lib/commands/types";
import type { ComposerSeedSource } from "@/lib/composer/composer-seed-source";
import {
  permissionFromChatRunSettings,
  reasoningFromChatRunSettings,
  selectionFromChatRunSettings,
  serviceTierFromChatRunSettings,
} from "@/lib/composer/chat-run-settings";

const EMPTY_MODELS: ReadonlyArray<ModelOption> = [];

/** The catalog a composer's toolbar store resolves selections against: which host's harnesses/models, and
 * whether only TUI-capable harnesses count. */
export interface ComposerToolbarCatalogScope {
  /** The harness + model catalog is fetched through this client, so the harnesses/models the store resolves and
   * validates a selection against are that host's. */
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  /** `null` while the target host is still resolving - memory writes are dropped, never misattributed. */
  readonly hostId: string | null;
  readonly tuiOnly: boolean;
}

/** `authoritative` (a chat composer once its own `chat.settings` seed the composer): the seed IS a real
 * commitment. */
export function useComposerToolbarStore(
  registerAs: FocusedComposerKind | null,
  seedSource: ComposerSeedSource,
  onSettingsChange: ((settings: ChatRunSettings) => void) | null,
  catalog: ComposerToolbarCatalogScope,
): ComposerToolbarStore {
  const { hostClient, hostId, tuiOnly } = catalog;
  const activityEnabled = useSurfaceActivity();
  const defaultPermission = useSettingsStore((s) => s.defaultPermission);
  const defaultSelection = useSettingsStore((s) => s.defaultSelection);
  const defaultReasoning = useSettingsStore((s) => s.defaultReasoning);
  const defaultServiceTier = useSettingsStore((s) => s.defaultServiceTier);
  const settingsSeed = seedSource.kind === "none" ? null : seedSource.settings;
  const seedIsAuthoritative = seedSource.kind === "authoritative";
  const seedClient = seedSource.kind === "fallback" ? seedSource.client : null;
  const rawSeedProfileId = settingsSeed?.profileId ?? null;
  const resolvedSeedProfileId = useResolvedSeededProfileId(
    settingsSeed?.harnessId ?? "traycer",
    rawSeedProfileId,
    activityEnabled && !seedIsAuthoritative,
    seedClient,
  );
  const effectiveSeedProfileId = seedIsAuthoritative
    ? rawSeedProfileId
    : resolvedSeedProfileId;
  const resolvedSettingsSeed = useMemo(() => {
    if (settingsSeed === null) return null;
    return effectiveSeedProfileId === settingsSeed.profileId
      ? settingsSeed
      : { ...settingsSeed, profileId: effectiveSeedProfileId };
  }, [settingsSeed, effectiveSeedProfileId]);
  const seedKey = chatRunSettingsSeedKey(resolvedSettingsSeed);
  const seededValues = useMemo(
    () =>
      valuesFromSettingsSeed(resolvedSettingsSeed, {
        permission: defaultPermission,
        selection: defaultSelection,
        reasoning: defaultReasoning,
        serviceTier: defaultServiceTier,
      }),
    [
      defaultPermission,
      defaultReasoning,
      defaultServiceTier,
      defaultSelection,
      resolvedSettingsSeed,
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
      hostId,
    }),
  );
  // It records only when the resolved slug is catalog-confirmed (`selectionCatalogConfirmed`, exposed by the
  // store) - the catalog-confirmed write gate.
  const recordingOnSettingsChange = useCallback(
    (settings: ChatRunSettings) => {
      // Precondition: every store emit site `set`s the derived state before invoking `onSettingsChange`, so
      // `getState.selectionCatalogConfirmed` here reflects the very settings being emitted.
      const state = store.getState();
      if (state.selectionCatalogConfirmed) {
        useComposerHarnessMemoryStore
          .getState()
          .record(state.catalog.hostId, settings);
      }
      onSettingsChange?.(settings);
    },
    [store, onSettingsChange],
  );
  useEffect(() => {
    store.getState().setOnSettingsChange(recordingOnSettingsChange);
  }, [store, recordingOnSettingsChange]);
  // A layout effect, not a passive one: ticket 07 round 2's transition-window gap.
  useLayoutEffect(() => {
    store.getState().applySeed(seedKey, seededValues);
  }, [store, seedKey, seededValues]);

  // The models query follows the store's resolved harness (availability rerouting included); `modelsHarnessId`
  // rides along so a stale response can never resolve a slug for the wrong harness.
  const harnessId = useStore(store, (s) => s.selection.harnessId);
  const harnessesQuery = useGuiHarnessesQueryForClient(hostClient, {
    enabled: activityEnabled,
    subscribed: activityEnabled,
  });
  const modelsQuery = useGuiHarnessModelsQueryForClient(
    hostClient,
    harnessId,
    null,
    {
      enabled: activityEnabled,
      subscribed: activityEnabled,
    },
  );
  // Read the cache regardless of `activityEnabled`.
  const harnesses = harnessesQuery.data?.harnesses;
  const models = modelsQuery.data?.models ?? EMPTY_MODELS;
  // Never inferred from `models.length`.
  const modelsLoaded = modelsQuery.data !== undefined;
  useEffect(() => {
    store.getState().setCatalog({
      hostId,
      harnesses,
      modelsHarnessId: harnessId,
      models,
      modelsLoaded,
      tuiOnly,
    });
  }, [store, hostId, harnesses, models, modelsLoaded, harnessId, tuiOnly]);

  const registeredControls = useMemo(() => {
    const actions = store.getState();
    return {
      setReasoning: actions.setReasoning,
      setServiceTier: actions.setServiceTier,
      setPermission: actions.setPermission,
      // The command palette has no rail/profile context of its own - default the independent profile choice to
      // ambient while restoring the provider's last-used model/effort/tier.
      switchHarness: (harnessId: ProviderId) =>
        commitSelection(store, harnessId, null, null),
      selectModel: (harnessId: ProviderId, modelSlug: string) =>
        commitSelection(store, harnessId, modelSlug, null),
    };
  }, [store]);
  // The palette's composer subpages list the catalog of the same host this store reads it through, so what they
  // offer is what `switchHarness` / `selectModel` can commit against.
  useRegisterFocusedComposerControls(
    activityEnabled ? registerAs : null,
    registeredControls,
    hostClient,
  );

  return store;
}

interface ComposerToolbarDefaults {
  readonly permission: PermissionMode;
  readonly selection: HarnessModelSelection;
  readonly reasoning: ReasoningLevel;
  readonly serviceTier: ServiceTier;
}

function chatRunSettingsSeedKey(settingsSeed: ChatRunSettings | null): string {
  if (settingsSeed === null) return "default";
  return [
    settingsSeed.harnessId,
    settingsSeed.model,
    settingsSeed.permissionMode,
    settingsSeed.reasoningEffort ?? "",
    settingsSeed.serviceTier ?? "",
    settingsSeed.profileId ?? "",
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
  };
}
