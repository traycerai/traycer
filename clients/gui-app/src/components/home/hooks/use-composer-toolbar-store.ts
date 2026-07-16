import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
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
import { useResolvedSeededProfileId } from "@/hooks/providers/use-resolved-seeded-profile-id";
import type { FocusedComposerKind } from "@/lib/commands/types";
import type { ComposerSeedSource } from "@/lib/composer/composer-seed-source";
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
 * - settings-store defaults / the seeded settings (re-seeds when the seed
 *   identity changes);
 * - the harness + model catalog queries, gated on the surrounding
 *   `SurfaceActivityContext`;
 * - the latest `onSettingsChange` callback.
 *
 * When `registerAs !== null` (and the surface is active), the store's setters
 * are registered with the focused-composer-controls registry so the command
 * palette's "Switch model" / "Switch provider" items dispatch against this
 * composer.
 *
 * `seedSource` (S11: replaces the old positional `settingsSeed` +
 * `client` + `seedIsAuthoritative` trio) decides both WHAT seeds the store
 * and WHETHER a dead `profileId` may be silently corrected to ambient - the
 * load-bearing distinction that keeps this validation from fighting the
 * reauth gate's OWN missing-profile feature:
 * - `none`: no seed - the store falls back to settings-store defaults.
 * - `fallback` (fork dialogs, the landing composer, the new-conversation
 *   modal, and a chat composer's fallback-seeded window before its own
 *   settings hydrate): the seed is a picker default, not a commitment anyone
 *   is relying on - its `profileId` is validated against `seedSource.client`
 *   (the SAME host this composer will actually run turns on) and corrected
 *   to ambient (`null`) if dead, so it can never reach a fork/new-chat
 *   submission or falsely accuse itself of being "missing" in
 *   `useProviderReauthGate`.
 * - `authoritative` (a chat composer once its OWN `chat.settings` seed the
 *   composer): the seed IS a real commitment - a dead `profileId` is passed
 *   through UNVALIDATED so `useProviderReauthGate` (fed the identical
 *   `seedSource.kind`) can detect and BLOCK it with a banner, never silently
 *   swap to ambient behind the user's back.
 *
 * Returns the store itself: toolbar leaves subscribe to slices, submit paths
 * read `store.getState()`.
 */
export function useComposerToolbarStore(
  registerAs: FocusedComposerKind | null,
  seedSource: ComposerSeedSource,
  onSettingsChange: ((settings: ChatRunSettings) => void) | null,
  tuiOnly: boolean,
): ComposerToolbarStore {
  const activityEnabled = useSurfaceActivity();
  const defaultPermission = useSettingsStore((s) => s.defaultPermission);
  const defaultSelection = useSettingsStore((s) => s.defaultSelection);
  const defaultReasoning = useSettingsStore((s) => s.defaultReasoning);
  const defaultServiceTier = useSettingsStore((s) => s.defaultServiceTier);
  const defaultAgentMode = useSettingsStore((s) => s.defaultAgentMode);
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
        agentMode: defaultAgentMode,
      }),
    [
      defaultPermission,
      defaultAgentMode,
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
  // key, so default-value churn never clobbers user edits). A LAYOUT effect,
  // not a passive one: ticket 07 round 2's transition-window gap - a seed
  // whose `profileId` flips (e.g. `resolveSeededProfileId` clearing a stale
  // pin once `providers.list` settles) must land in the store before the
  // browser paints, so a submit triggered by the very next user interaction
  // can never read a stale committed `selection` through a passive-effect
  // scheduling gap. `applySeed`'s no-op-on-matching-key guard keeps this
  // synchronous timing side-effect-free for every other render.
  useLayoutEffect(() => {
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
      // The command palette has no rail/profile context of its own - default
      // the independent profile choice to ambient while restoring the
      // provider's last-used model/effort/tier.
      switchHarness: (harnessId: ProviderId) =>
        commitSelection(store, harnessId, null, null),
      selectModel: (harnessId: ProviderId, modelSlug: string) =>
        commitSelection(store, harnessId, modelSlug, null),
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
    agentMode: agentModeFromChatRunSettings(settingsSeed),
  };
}
